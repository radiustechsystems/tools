import { FacilitatorResponseError, getFacilitatorResponseError, type FacilitatorClient } from '@x402/core/server';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { SettleError, type PaymentPayload, type PaymentRequirements, type SettleResponse } from '@x402/core/types';
import type { SettlementClassifier } from '../outcome.js';
import { explorerTxUrl, type PaymentNetwork } from '../networks.js';
import type { PaymentReceipt } from '../receipt.js';
import {
  MPP_INTENT,
  MPP_METHOD,
  MPP_RECEIPT_HEADER,
  encodeRequest,
  mppChallengeId,
  mppChallengeNonce,
  mppHmacKey,
  mppSource,
  parseMppCredential,
  serializeMppChallenge,
  serializeMppReceipt,
  type MppChallenge,
} from '../mpp.js';

export interface MppServerOptions {
  /**
   * Key for the HMAC that binds challenge ids to their parameters, so credentials are verified
   * without storing challenges. At least 32 characters of random data (`openssl rand -base64 32`);
   * keep it stable across instances that serve the same routes.
   */
  secretKey: string;
  /** Realm named in challenges. Default: the request's host. */
  realm?: string;
}

/** What the payment server needs from `RadiusServer`. @internal */
export interface MppHost {
  readonly networks: readonly PaymentNetwork[];
  facilitatorFor(network: PaymentNetwork): FacilitatorClient;
  readonly classifySettlement: SettlementClassifier;
}

/**
 * Outcome of an MPP credential check: settle-ready details, or the reason to answer 402 / 502 / 503.
 * A failed settle carries the facilitator's `settle` response, or the `error` when it gave none.
 */
export type MppVerification =
  | { ok: true; network: PaymentNetwork; requirements: PaymentRequirements; payload: PaymentPayload; payer: string }
  | { ok: false; status: 402 | 502 | 503; reason: string; settle?: SettleResponse; error?: unknown };

const PROBLEM_TYPE = 'https://paymentauth.org/problems/verification-failed';

/**
 * MPP (the HTTP `Payment` auth scheme, `evm` charge method) alongside x402. Challenges mirror the
 * x402 offers a route resolves to (same amount, asset, recipient and network), and credentials,
 * EIP-3009 authorizations, are settled through the same facilitators, converted to x402 `exact`
 * payloads. No state: the challenge id is an HMAC of its parameters.
 */
export class MppPayments {
  private hmacKey?: Promise<CryptoKey>;

  constructor(
    private readonly host: MppHost,
    private readonly options: MppServerOptions,
  ) {
    if (typeof options.secretKey !== 'string' || options.secretKey.length < 32) {
      throw new Error('radius-sdk: mpp.secretKey must be at least 32 characters of random data (e.g. `openssl rand -base64 32`)');
    }
  }

  /** The HMAC key for challenge ids, imported once (lazily: no I/O or crypto at construction). */
  private key(): Promise<CryptoKey> {
    return (this.hmacKey ??= mppHmacKey(this.options.secretKey));
  }

  private realmOf(request: Request): string {
    return this.options.realm ?? new URL(request.url).host;
  }

  private networkOf(chainId: unknown): PaymentNetwork | undefined {
    return this.host.networks.find((n) => n.chainId === chainId);
  }

  /**
   * x402 offers of a 402 that MPP can mirror: `exact` by EIP-3009 (MPP's `evm` charge is an EIP-3009
   * authorization; a Permit2-only offer is not payable that way), on a configured network, in its asset.
   */
  private mirrorable(x402Challenge: Response): { accepts: { requirements: PaymentRequirements; network: PaymentNetwork }[]; description?: string } {
    const header = x402Challenge.headers.get('payment-required');
    if (!header) return { accepts: [] };
    const pr = decodePaymentRequiredHeader(header);
    const accepts = pr.accepts.flatMap((requirements) => {
      const network = this.host.networks.find((n) => n.network === requirements.network);
      if (!network || requirements.scheme !== 'exact' || requirements.asset.toLowerCase() !== network.asset.address.toLowerCase()) return [];
      if (requirements.extra?.assetTransferMethod !== 'eip3009') return [];
      return [{ requirements, network }];
    });
    return { accepts, description: pr.resource?.description || undefined };
  }

  /** The `WWW-Authenticate` challenges for a route's x402 402 (one per network). */
  async challenges(request: Request, x402Challenge: Response): Promise<string[]> {
    const { accepts, description } = this.mirrorable(x402Challenge);
    const realm = this.realmOf(request);
    return Promise.all(
      accepts.map(async ({ requirements, network }) => {
        const body = {
          amount: requirements.amount,
          currency: requirements.asset,
          recipient: requirements.payTo,
          methodDetails: { chainId: network.chainId, credentialTypes: ['authorization'], decimals: network.asset.decimals },
        };
        const fields: Omit<MppChallenge, 'id'> = {
          realm,
          method: MPP_METHOD,
          intent: MPP_INTENT,
          request: body,
          requestEncoded: encodeRequest(body),
          ...(description && { description }),
          expires: new Date(Date.now() + requirements.maxTimeoutSeconds * 1000).toISOString(),
        };
        return serializeMppChallenge({ id: await mppChallengeId(await this.key(), fields), ...fields });
      }),
    );
  }

  /** Add MPP challenges to an x402 402 (in place; the response must have mutable headers). */
  async addChallenges(request: Request, res: Response): Promise<Response> {
    for (const c of await this.challenges(request, res)) res.headers.append('WWW-Authenticate', c);
    return res;
  }

  /**
   * Check an `Authorization: Payment` credential against the route's current x402 offers (from its
   * unpaid 402): HMAC id, realm, expiry, method, the exact amount / asset / recipient / network,
   * the authorization's nonce binding and validity window, then the facilitator's `/verify`.
   */
  async verify(request: Request, x402Challenge: Response): Promise<MppVerification> {
    let credential: ReturnType<typeof parseMppCredential>;
    try {
      credential = parseMppCredential(request.headers.get('authorization'));
    } catch (e) {
      return { ok: false, status: 402, reason: `malformed credential: ${(e as Error).message}` };
    }
    if (!credential) return { ok: false, status: 402, reason: 'no Payment credential' };
    const { challenge: c, payload: p, source } = credential;
    const fail = (reason: string): MppVerification => ({ ok: false, status: 402, reason });

    const { id, ...fields } = c;
    if (!timingSafeEqual(id, await mppChallengeId(await this.key(), fields))) return fail('challenge was not issued by this server');
    if (c.realm !== this.realmOf(request)) return fail('challenge realm does not match');
    if (c.method !== MPP_METHOD || c.intent !== MPP_INTENT) return fail(`unsupported method ${c.method}/${c.intent}`);
    const expires = c.expires ? Date.parse(c.expires) : Number.NaN;
    if (!Number.isFinite(expires) || expires < Date.now()) return fail('challenge expired');

    const r = c.request as { amount?: unknown; currency?: unknown; recipient?: unknown; methodDetails?: { chainId?: unknown } };
    const network = this.networkOf(r.methodDetails?.chainId);
    if (!network || typeof r.currency !== 'string' || typeof r.recipient !== 'string' || typeof r.amount !== 'string') return fail('credential request is not payable here');
    const match = this.mirrorable(x402Challenge).accepts.find(
      (a) =>
        a.network === network &&
        a.requirements.asset.toLowerCase() === (r.currency as string).toLowerCase() &&
        a.requirements.payTo.toLowerCase() === (r.recipient as string).toLowerCase() &&
        a.requirements.amount === r.amount,
    );
    if (!match) return fail("credential does not match this route's price");

    if (!p || p.type !== 'authorization') return fail('payload is not an EIP-3009 authorization');
    if (String(p.to).toLowerCase() !== r.recipient.toLowerCase()) return fail('authorization recipient mismatch');
    if (p.value !== r.amount) return fail('authorization amount mismatch');
    if (String(p.nonce).toLowerCase() !== mppChallengeNonce(c)) return fail('authorization is not bound to this challenge');
    const now = BigInt(Math.floor(Date.now() / 1000));
    try {
      if (BigInt(p.validAfter) > now) return fail('authorization is not valid yet');
      if (BigInt(p.validBefore) <= now) return fail('authorization has expired');
    } catch {
      return fail('authorization validity window is malformed');
    }
    if (source !== undefined && source.toLowerCase() !== mppSource(network.chainId, p.from).toLowerCase()) return fail('credential source does not match the payer');

    // The offer the credential matched, as the route's x402 402 lists it (the facilitator's EIP-712
    // domain and extras included): the facilitator sees the same requirements an x402 payer would.
    const { requirements } = match;
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: {
        authorization: { from: p.from, to: p.to, value: p.value, validAfter: p.validAfter, validBefore: p.validBefore, nonce: p.nonce },
        signature: p.signature,
      },
    };
    try {
      const verified = await this.host.facilitatorFor(network).verify(payload, requirements);
      if (!verified.isValid) return fail(verified.invalidMessage ?? verified.invalidReason ?? 'facilitator rejected the authorization');
    } catch (e) {
      return facilitatorFailure(e);
    }
    return { ok: true, network, requirements, payload, payer: p.from };
  }

  /** Settle a verified credential; the receipt on success. */
  async settle(v: Extract<MppVerification, { ok: true }>): Promise<{ ok: true; receipt: PaymentReceipt } | Extract<MppVerification, { ok: false }>> {
    try {
      const settled = await this.host.facilitatorFor(v.network).settle(v.payload, v.requirements);
      if (!settled.success || !settled.transaction) {
        const reason = settled.errorMessage ?? settled.errorReason ?? 'settlement failed';
        return { ok: false, status: this.failureStatus(settled), reason, settle: settled };
      }
      return {
        ok: true,
        receipt: {
          success: true,
          protocol: 'mpp',
          transaction: settled.transaction,
          network: v.network.network,
          payer: settled.payer ?? v.payer,
          amount: v.requirements.amount,
          explorerUrl: explorerTxUrl(v.network, settled.transaction),
        },
      };
    } catch (e) {
      if (e instanceof SettleError) {
        const settle: SettleResponse = { success: false, errorReason: e.errorReason, errorMessage: e.errorMessage, transaction: e.transaction ?? '', network: e.network ?? v.network.network, payer: e.payer };
        return { ok: false, status: this.failureStatus(settle), reason: e.message, settle };
      }
      return { ...facilitatorFailure(e), error: e };
    }
  }

  /** 503 for a pending settlement, 502 for an unknown one, else 402. */
  private failureStatus(settle: SettleResponse): 402 | 502 | 503 {
    const status = this.host.classifySettlement(settle);
    return status === 'pending' ? 503 : status === 'unknown' ? 502 : 402;
  }

  /** `Payment-Receipt` header value for a settled payment. */
  receiptHeader(receipt: PaymentReceipt): string {
    return serializeMppReceipt({ method: MPP_METHOD, reference: receipt.transaction ?? '', status: 'success', timestamp: new Date().toISOString() });
  }

  /** A 402 that explains a failed credential and offers fresh challenges (and the route's x402 offers). */
  async rejection(request: Request, x402Challenge: Response, reason: string): Promise<Response> {
    const res = new Response(JSON.stringify({ type: PROBLEM_TYPE, title: 'Payment verification failed', status: 402, detail: reason }), {
      status: 402,
      headers: x402Challenge.headers,
    });
    res.headers.set('Content-Type', 'application/problem+json');
    return this.addChallenges(request, res);
  }
}

export { MPP_RECEIPT_HEADER };

function facilitatorFailure(e: unknown): Extract<MppVerification, { ok: false }> {
  const fe = getFacilitatorResponseError(e) ?? (e instanceof FacilitatorResponseError ? e : undefined);
  if (fe) return { ok: false, status: 502, reason: fe.message };
  // The facilitator answered with its own rejection (VerifyError / SettleError).
  return { ok: false, status: 402, reason: e instanceof Error ? e.message : String(e) };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
