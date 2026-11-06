/**
 * Pending and unknown settlement, end to end: the real buyer (`createRadiusFetch`) pays the real
 * seller (`radiusPayments`) in process. The facilitator is a stub that follows the contract the SDK
 * assumes (see `classifySettlement`): a settle whose receipt wait timed out answers
 * `settlement_pending` with the broadcast hash, and presenting the identical payment again settles
 * against that transaction instead of a second one. The chain is a stubbed viem client. Nothing
 * here touches a network or a funded wallet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse } from '@x402/core/types';
import {
  classifySettlement,
  createRadiusFetch,
  getPaymentReceipt,
  isTerminalSettlement,
  reconcilePayment,
  validatePaymentReceipt,
  RadiusPaymentError,
  type PaymentOutcome,
  type PaymentRejectedDetails,
  type PendingPayment,
  type ReconcileOffer,
} from '../src/client/index.js';
import { createRadiusServer, radiusPayments, type SettlementOutcome } from '../src/server/index.js';
import { resolveNetwork } from '../src/networks.js';

const NETWORK = resolveNetwork('base-sepolia', { rpcUrl: 'http://127.0.0.1:1' });
const ASSET = NETWORK.asset.address;
const BUYER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PAY_TO = '0x000000000000000000000000000000000000dEaD' as Address;
const TX = `0x${'ab'.repeat(32)}` as Hex;
const PRICE = 1000n; // '0.001' USDC
const URL_PAID = 'http://seller.test/api/report';
const FAST = { initialDelayMs: 1, maxDelayMs: 5 };

afterEach(() => vi.restoreAllMocks());

// -- chain ---------------------------------------------------------------------------------------

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** A chain that knows `TX` once `mined` (succeeded or reverted) and answers EIP-3009 `authorizationState`. */
function chain() {
  const state = { mined: undefined as undefined | 'success' | 'reverted', authorizationUsed: false as boolean | 'error', reads: 0 };
  const client = {
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      state.reads++;
      if (hash !== TX || !state.mined) throw new Error(`Transaction receipt with hash "${hash}" could not be found.`);
      return {
        status: state.mined,
        blockNumber: 9n,
        logs:
          state.mined === 'success'
            ? [{ address: ASSET, topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from: BUYER.address, to: PAY_TO } }), data: encodeAbiParameters([{ type: 'uint256' }], [PRICE]), blockNumber: 9n, logIndex: 0, transactionHash: TX }]
            : [],
      };
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      state.reads++;
      if (functionName !== 'authorizationState') throw new Error(`unexpected read ${functionName}`);
      if (state.authorizationUsed === 'error') throw new Error('rpc down');
      return state.authorizationUsed;
    },
  } as unknown as PublicClient;
  return { state, client };
}

// -- facilitator ---------------------------------------------------------------------------------

type Step = 'pending' | 'success' | 'reverted' | 'reject' | 'hang';

/**
 * A facilitator that plays `steps` in order, one per `/settle` call, repeating the last. It records
 * every signature it was asked to settle and every broadcast. `success` and `pending` both report the
 * one transaction `TX`: re-presenting the same payment never broadcasts a second one.
 */
function facilitator(steps: Step[]) {
  const seen = { settleCalls: 0, verifyCalls: 0, broadcasts: 0, signatures: new Set<string>() };
  let i = 0;
  const response = (step: Step, requirements: PaymentRequirements): SettleResponse => {
    const base = { network: requirements.network, payer: BUYER.address };
    if (step === 'pending') return { ...base, success: false, errorReason: 'settlement_pending', errorMessage: 'receipt wait timed out', transaction: TX };
    if (step === 'success') return { ...base, success: true, transaction: TX };
    if (step === 'reverted') return { ...base, success: false, errorReason: 'transaction_failed', transaction: TX };
    return { ...base, success: false, errorReason: 'invalid_exact_evm_payload_authorization_nonce', transaction: '' };
  };
  const client: FacilitatorClient = {
    verify: async () => {
      seen.verifyCalls++;
      return { isValid: true, payer: BUYER.address };
    },
    settle: async (payload: PaymentPayload, requirements: PaymentRequirements) => {
      seen.settleCalls++;
      seen.signatures.add(String((payload.payload as { signature?: string }).signature));
      if (seen.broadcasts === 0) seen.broadcasts = 1; // the first settle broadcasts TX; later ones reuse it
      const step = steps[Math.min(i++, steps.length - 1)];
      if (step === 'hang') throw new Error('socket hang up');
      return response(step, requirements);
    },
    getSupported: async (): Promise<SupportedResponse> => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK.network, extra: { assetTransferMethod: 'eip3009', name: NETWORK.asset.name, version: NETWORK.asset.version } }],
      extensions: [],
      signers: {},
    }),
  };
  return { client, seen };
}

// -- seller and buyer ----------------------------------------------------------------------------

function seller(fac: FacilitatorClient, settle: 'before' | 'after' = 'before') {
  const outcomes: SettlementOutcome[] = [];
  let deliveries = 0;
  const pay = radiusPayments({
    network: NETWORK,
    facilitator: fac,
    settle,
    settlementRetryAfter: 0,
    payTo: PAY_TO,
    routes: { 'GET /api/report': '0.001', 'POST /api/report': '0.001' },
    onSettlement: (outcome) => {
      outcomes.push(outcome);
    },
  });
  const app = pay.wrap(async (request) => {
    deliveries++;
    const body = request.method === 'POST' ? await request.text() : '';
    return Response.json({ report: 'CONTENT', body });
  });
  return { app, outcomes, deliveries: () => deliveries };
}

/** The buyer, with a signer that counts signatures; `lose(n)` drops the response to the n-th paid request. */
function buyer(app: (r: Request) => Promise<Response>, opts: { lose?: (paidRequest: number) => boolean; onPaymentPending?: (p: PendingPayment) => void } = {}) {
  const signatures: string[] = [];
  const paymentHeaders: string[] = [];
  const signer = { address: BUYER.address, signTypedData: vi.fn((args: Parameters<typeof BUYER.signTypedData>[0]) => BUYER.signTypedData(args)) };
  let paid = 0;
  const payFetch = createRadiusFetch({
    network: NETWORK,
    signer,
    maxPerRequest: '0.01',
    onPaymentPending: opts.onPaymentPending,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const header = request.headers.get('payment-signature');
      if (header) {
        paid++;
        paymentHeaders.push(header);
        const signature = JSON.parse(Buffer.from(header, 'base64').toString()).payload.signature;
        signatures.push(signature);
      }
      const res = await app(request);
      if (header && opts.lose?.(paid)) {
        await res.arrayBuffer(); // the seller finished, but the buyer never sees the answer
        throw new TypeError('fetch failed: response lost');
      }
      return res;
    }) as typeof fetch,
  });
  return { payFetch, signer, signatures, paymentHeaders, paidRequests: () => paid };
}

function expectStatus<S extends PaymentOutcome['status']>(outcome: PaymentOutcome, status: S): Extract<PaymentOutcome, { status: S }> {
  expect(outcome.status, 'reason' in outcome ? String(outcome.reason) : undefined).toBe(status);
  return outcome as Extract<PaymentOutcome, { status: S }>;
}

/** No authorization was created after the first: one signature, every presentation carries it unchanged. */
function expectSamePayment(b: ReturnType<typeof buyer>) {
  expect(b.signer.signTypedData).toHaveBeenCalledTimes(1);
  expect(new Set(b.paymentHeaders).size).toBe(1);
  expect(new Set(b.signatures).size).toBe(1);
}

// -- tests ---------------------------------------------------------------------------------------

describe('classifySettlement (the assumed facilitator contract)', () => {
  it('maps settle responses to outcomes', () => {
    expect(classifySettlement({ success: true, transaction: TX })).toBe('settled');
    expect(classifySettlement({ success: false, errorReason: 'settlement_pending', transaction: TX })).toBe('pending');
    expect(classifySettlement({ success: false, errorReason: 'settlement_pending', transaction: '' })).toBe('pending');
    expect(classifySettlement({ success: false, errorReason: 'settlement_unknown' })).toBe('unknown');
    expect(classifySettlement({ success: false, errorReason: 'transaction_failed', transaction: TX })).toBe('failed');
    expect(classifySettlement({ success: false, errorReason: 'insufficient_funds', transaction: '' })).toBe('rejected');
  });

  it('separates terminal from retryable outcomes', () => {
    expect(['settled', 'rejected', 'failed'].every(isTerminalSettlement)).toBe(true);
    expect(['pending', 'unknown', 'something_new'].some(isTerminalSettlement)).toBe(false);
  });
});

describe('receipts of a pending settlement', () => {
  const pendingReceipt = { success: false, protocol: 'x402' as const, transaction: TX, network: NETWORK.network, payer: BUYER.address, errorReason: 'settlement_pending' };
  const offer: ReconcileOffer = { scheme: 'exact', amount: PRICE.toString(), asset: ASSET, payTo: PAY_TO, network: NETWORK };

  it('validatePaymentReceipt marks them pending and keeps the transaction', () => {
    const r = validatePaymentReceipt(pendingReceipt, { scheme: 'exact', amount: '1000', network: NETWORK, payer: BUYER.address });
    expect(r).toMatchObject({ transaction: TX, charge: { evidence: 'pending', authorized: '1000' } });
    expect(() => validatePaymentReceipt({ ...pendingReceipt, transaction: '0x12' }, { scheme: 'exact', amount: '1000', network: NETWORK })).toThrow(RadiusPaymentError);
  });

  it('reconcilePayment reads the chain for them: unresolved while unknown, then confirmed or reverted', async () => {
    const { state, client } = chain();
    expect(await reconcilePayment(pendingReceipt, offer, { client })).toMatchObject({ status: 'unresolved', reason: 'not_found' });
    state.mined = 'success';
    expect(await reconcilePayment(pendingReceipt, offer, { client })).toMatchObject({ status: 'confirmed', confirmed: PRICE, reported: PRICE });
    state.mined = 'reverted';
    expect(await reconcilePayment(pendingReceipt, offer, { client })).toMatchObject({ status: 'reverted', confirmed: 0n });
  });

  it('reconcilePayment still reports a failure without a transaction as unresolved', async () => {
    const r = await reconcilePayment({ ...pendingReceipt, errorReason: 'insufficient_funds', transaction: undefined }, offer, { client: chain().client });
    expect(r).toMatchObject({ status: 'unresolved', reason: 'receipt_failed' });
  });
});

describe('seller: pending and unknown settlement are not rejections', () => {
  for (const settle of ['before', 'after'] as const) {
    it(`settle: '${settle}' answers a pending settlement with 503, the pending receipt and Retry-After, and withholds the content`, async () => {
      const fac = facilitator(['pending']);
      const s = seller(fac.client, settle);
      const b = buyer(s.app);
      const res = await b.payFetch(URL_PAID);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('0');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body).toMatchObject({ error: 'settlement_pending', transaction: TX });
      expect(JSON.stringify(body)).not.toContain('CONTENT');
      expect(getPaymentReceipt(res)).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: TX });
      // x402 core re-presents a pending settle once on its own; both calls report the one transaction.
      expect(fac.seen.settleCalls).toBe(2);
      expect(s.deliveries()).toBe(settle === 'after' ? 1 : 0);
      expect(s.outcomes.map((o) => o.status)).toEqual(['pending']);
      expect(s.outcomes[0]).toMatchObject({ phase: `${settle}-handler`, receipt: { transaction: TX, charge: { evidence: 'pending' } } });
      expect(s.outcomes[0].payment.payload.payload).toHaveProperty('signature');
    });

    it(`settle: '${settle}' answers a settle with no facilitator answer with 502 settlement: 'unknown'`, async () => {
      const fac = facilitator(['hang']);
      const s = seller(fac.client, settle);
      const res = await buyer(s.app).payFetch(URL_PAID);
      expect(res.status).toBe(502);
      expect(res.headers.get('retry-after')).toBe('0');
      expect(await res.json()).toMatchObject({ error: 'facilitator_error', settlement: 'unknown' });
      expect(s.outcomes.map((o) => o.status)).toEqual(['unknown']);
      expect(s.outcomes[0].receipt).toMatchObject({ success: false, errorReason: 'settlement_unknown' });
    });

    it(`settle: '${settle}' keeps 402 for rejections and reports rejected and failed outcomes`, async () => {
      for (const [step, status] of [['reject', 'rejected'], ['reverted', 'failed']] as const) {
        const s = seller(facilitator([step]).client, settle);
        const outcome = await buyer(s.app).payFetch.pay(URL_PAID, undefined, { client: chain().client });
        expect(s.outcomes.map((o) => o.status)).toEqual([status]);
        if (status === 'rejected') expect(expectStatus(outcome, 'rejected').response?.status).toBe(402);
      }
    });
  }

  it('reports settled outcomes next to onSettled', async () => {
    const s = seller(facilitator(['success']).client);
    const res = await buyer(s.app).payFetch(URL_PAID);
    expect(res.status).toBe(200);
    expect(s.outcomes.map((o) => [o.status, o.phase])).toEqual([['settled', 'before-handler']]);
  });

  it('a failed /verify (settle: after) is a 502 without settlement: unknown: nothing was submitted', async () => {
    const fac = facilitator(['success']);
    fac.client.verify = async () => {
      throw new Error('verify connection reset');
    };
    const s = seller(fac.client, 'after');
    const res = await buyer(s.app).payFetch(URL_PAID);
    expect(res.status).toBe(502);
    expect(await res.json()).not.toHaveProperty('settlement');
    expect(fac.seen.settleCalls).toBe(0);
  });

  it('honours a custom classifier for another facilitator contract', async () => {
    const fac = facilitator(['reject']);
    const outcomes: SettlementOutcome[] = [];
    const pay = radiusPayments({
      network: NETWORK, facilitator: fac.client, payTo: PAY_TO, settlementRetryAfter: 7,
      routes: { 'GET /api/report': '0.001' },
      classifySettlement: (r) => (r.errorReason?.endsWith('_nonce') ? 'pending' : classifySettlement(r)),
      onSettlement: (o) => {
        outcomes.push(o);
      },
    });
    const res = await buyer(pay.wrap(() => Response.json({}))).payFetch(URL_PAID);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(outcomes[0].status).toBe('pending');
  });
});

describe('buyer: pay() and resume() recover the original authorization', () => {
  it('delayed settlement after the facilitator HTTP call timed out: resume delivers the original purchase, charged once', async () => {
    // Base Sepolia: the seller's facilitator call times out after broadcasting (no answer at all), and
    // a later presentation of the same payment finds the transaction settled.
    let hung = false;
    let broadcasts = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/supported')) {
        return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK.network, extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' } }], extensions: [], signers: {} });
      }
      if (url.endsWith('/settle')) {
        if (!hung) {
          hung = true;
          broadcasts++;
          const signal = (init?.signal ?? (input instanceof Request ? input.signal : undefined)) as AbortSignal;
          return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
        }
        return Response.json({ success: true, transaction: TX, network: NETWORK.network, payer: BUYER.address });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const outcomes: SettlementOutcome[] = [];
    let deliveries = 0;
    const pay = radiusPayments({
      network: NETWORK, facilitator: { url: 'https://facilitator.test', timeoutMs: 30 }, payTo: PAY_TO, settlementRetryAfter: 0,
      routes: { 'GET /api/report': '0.001' },
      onSettlement: (o) => {
        outcomes.push(o);
      },
    });
    const b = buyer(pay.wrap(() => {
      deliveries++;
      return Response.json({ report: 'CONTENT' });
    }));

    const first = expectStatus(await b.payFetch.pay(URL_PAID), 'unknown');
    expect(first.response?.status).toBe(502);
    expect(first.pending).toMatchObject({ status: 'unknown', attempts: 1, transaction: undefined, authorization: { kind: 'eip3009', from: BUYER.address } });
    expect(deliveries).toBe(0);

    const done = expectStatus(await b.payFetch.resume(first.pending, FAST), 'settled');
    expect(done).toMatchObject({ delivered: true, evidence: 'receipt', attempts: 2, receipt: { transaction: TX, success: true } });
    expect(await done.response!.json()).toEqual({ report: 'CONTENT' });
    expect(deliveries).toBe(1);
    expect(broadcasts).toBe(1);
    expect(outcomes.map((o) => o.status)).toEqual(['unknown', 'settled']);
    expectSamePayment(b);
    fetchSpy.mockRestore();
  });

  it('a lost response: the buyer resumes with the same payment and gets the purchase without a second charge', async () => {
    const fac = facilitator(['success']);
    const s = seller(fac.client);
    const pendings: PendingPayment[] = [];
    const b = buyer(s.app, { lose: (n) => n === 1, onPaymentPending: (p) => pendings.push(p) });

    const first = expectStatus(await b.payFetch.pay(URL_PAID), 'unknown');
    expect(first.reason).toMatch(/response lost/);
    expect(first.error).toBeInstanceOf(TypeError);
    expect(pendings).toHaveLength(1);

    const done = expectStatus(await b.payFetch.resume(first.pending, FAST), 'settled');
    expect(done.delivered).toBe(true);
    expect(await done.response!.json()).toMatchObject({ report: 'CONTENT' });
    expect(fac.seen.broadcasts).toBe(1);
    expect(fac.seen.signatures.size).toBe(1);
    expectSamePayment(b);
  });

  it('repeated pending results, then success: bounded backoff ends with the original purchase', async () => {
    // Each seller answer is two facilitator calls (x402 core retries a pending settle once).
    const fac = facilitator(['pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'success']);
    const s = seller(fac.client);
    const b = buyer(s.app);
    const { client } = chain();

    const first = expectStatus(await b.payFetch.pay(URL_PAID, undefined, { client }), 'pending');
    expect(first.pending).toMatchObject({ status: 'pending', transaction: TX, receipt: { charge: { evidence: 'pending' } } });
    expect(first.response?.status).toBe(503);

    const started = Date.now();
    const done = expectStatus(await b.payFetch.resume(first.pending, { initialDelayMs: 5, maxDelayMs: 20, client }), 'settled');
    expect(Date.now() - started).toBeGreaterThanOrEqual(5 + 10 - 2); // two waits: 5 ms, then 10 ms
    expect(done).toMatchObject({ delivered: true, attempts: 4, receipt: { transaction: TX } });
    expect(s.deliveries()).toBe(1);
    expect(s.outcomes.map((o) => o.status)).toEqual(['pending', 'pending', 'pending', 'settled']);
    expectSamePayment(b);
  });

  it('repeated pending results, then a definitive failure: the chain confirms the revert', async () => {
    const fac = facilitator(['pending', 'pending', 'pending', 'pending', 'reverted']);
    const s = seller(fac.client);
    const b = buyer(s.app);
    const { state, client } = chain();

    const first = expectStatus(await b.payFetch.pay(URL_PAID, undefined, { client }), 'pending');
    state.mined = 'reverted';
    const done = expectStatus(await b.payFetch.resume(first.pending, { ...FAST, client }), 'failed');
    expect(done.reconciliation).toMatchObject({ status: 'reverted', transaction: TX });
    expect(s.deliveries()).toBe(0);
    expectSamePayment(b);
  });

  it('a reported failure the chain does not show yet stays unknown, and a reported failure that settled on chain is settled', async () => {
    const fac = facilitator(['reverted']);
    const s = seller(fac.client);
    const b = buyer(s.app);
    const { state, client } = chain();
    const unconfirmed = expectStatus(await b.payFetch.pay(URL_PAID, undefined, { client }), 'unknown');
    expect(unconfirmed.pending.transaction).toBe(TX);

    state.mined = 'success';
    const b2 = buyer(seller(facilitator(['reverted']).client).app);
    const settled = expectStatus(await b2.payFetch.pay(URL_PAID, undefined, { client }), 'settled');
    expect(settled).toMatchObject({ delivered: false, evidence: 'chain', reconciliation: { status: 'confirmed' } });
  });

  it('settle: after recovers too, when the facilitator accepts the pending payment again', async () => {
    const fac = facilitator(['pending', 'pending', 'success']);
    const s = seller(fac.client, 'after');
    const b = buyer(s.app);
    const { client } = chain();
    const first = expectStatus(await b.payFetch.pay(URL_PAID), 'pending');
    const done = expectStatus(await b.payFetch.resume(first.pending, { ...FAST, client }), 'settled');
    expect(done.delivered).toBe(true);
    expect(s.outcomes.map((o) => [o.status, o.phase])).toEqual([['pending', 'after-handler'], ['settled', 'after-handler']]);
    // 'after' runs the handler before every settle: make it idempotent, or settle 'before'.
    expect(s.deliveries()).toBe(2);
    expectSamePayment(b);
  });

  it('replays the original method and body', async () => {
    const s = seller(facilitator(['success']).client);
    const b = buyer(s.app, { lose: (n) => n === 1 });
    const first = expectStatus(await b.payFetch.pay(URL_PAID, { method: 'POST', body: 'query=1', headers: { 'content-type': 'text/plain' } }), 'unknown');
    expect(first.pending.request).toMatchObject({ method: 'POST', url: URL_PAID });
    const done = expectStatus(await b.payFetch.resume(first.pending, FAST), 'settled');
    expect(await done.response!.json()).toEqual({ report: 'CONTENT', body: 'query=1' });
  });

  it('stops after maxAttempts while still pending, and never signs again', async () => {
    const fac = facilitator(['pending']);
    const s = seller(fac.client);
    const pendings: PendingPayment[] = [];
    const b = buyer(s.app, { onPaymentPending: (p) => pendings.push(p) });
    const first = expectStatus(await b.payFetch.pay(URL_PAID), 'pending');
    const out = expectStatus(await b.payFetch.resume(first.pending, { ...FAST, maxAttempts: 3, client: chain().client }), 'pending');
    expect(out.attempts).toBe(4);
    expect(out.pending.attempts).toBe(4);
    expect(b.paidRequests()).toBe(4);
    expect(pendings.map((p) => p.attempts)).toEqual([1, 4]); // handed over by pay(), then by resume() when it gave up
    expectSamePayment(b);
  });

  it('aborting the wait resolves with the pending payment, which can be resumed later', async () => {
    const fac = facilitator(['pending', 'pending', 'success']);
    const s = seller(fac.client);
    const b = buyer(s.app);
    const first = expectStatus(await b.payFetch.pay(URL_PAID), 'pending');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const aborted = expectStatus(await b.payFetch.resume(first.pending, { initialDelayMs: 60_000, maxDelayMs: 60_000, signal: controller.signal }), 'pending');
    expect(aborted.aborted).toBe(true);
    expect(b.paidRequests()).toBe(1); // aborting stopped the wait; it sent nothing and cancelled nothing

    const done = expectStatus(await b.payFetch.resume(aborted.pending, { ...FAST, client: chain().client }), 'settled');
    expect(done.delivered).toBe(true);
    expectSamePayment(b);
  });

  it('a seller that refuses the re-presented payment: the consumed authorization proves it settled', async () => {
    // The first settlement went through but the response was lost; the facilitator then refuses the
    // same authorization (nonce used) instead of answering idempotently.
    const fac = facilitator(['success', 'reject']);
    const s = seller(fac.client);
    const b = buyer(s.app, { lose: (n) => n === 1 });
    const { state, client } = chain();
    state.authorizationUsed = true;
    const first = expectStatus(await b.payFetch.pay(URL_PAID), 'unknown');
    const done = expectStatus(await b.payFetch.resume(first.pending, { ...FAST, client }), 'settled');
    expect(done).toMatchObject({ delivered: false, evidence: 'authorization' });
    expect(done.response?.status).toBe(402);
    expectSamePayment(b);
  });

  it('a refused re-presentation with an unused authorization: unknown until it expires, then failed', async () => {
    const fac = facilitator(['hang', 'reject']);
    const s = seller(fac.client);
    const b = buyer(s.app);
    const { client } = chain();
    const first = expectStatus(await b.payFetch.pay(URL_PAID), 'unknown');
    const stillValid = expectStatus(await b.payFetch.resume(first.pending, { ...FAST, client }), 'unknown');
    expect(stillValid.reason).toMatch(/unused but valid until/);
    expect(b.paidRequests()).toBe(2); // a refusal ends the attempts: presenting it again cannot help

    const expired: PendingPayment = { ...stillValid.pending, authorization: { ...stillValid.pending.authorization!, validBefore: Math.floor(Date.now() / 1000) - 3600 } };
    const done = expectStatus(await b.payFetch.resume(expired, { ...FAST, client }), 'failed');
    expect(done.reason).toMatch(/expired unused/);
    expectSamePayment(b);
  });

  it('the first answer is a rejection: rejected, nothing moved', async () => {
    const s = seller(facilitator(['reject']).client);
    const outcome = expectStatus(await buyer(s.app).payFetch.pay(URL_PAID), 'rejected');
    expect(outcome.response?.status).toBe(402);
    expect(outcome.reason).toMatch(/rejected/);
  });

  it('a resource without a price is not_required', async () => {
    const b = buyer(async () => Response.json({ free: true }));
    expect((await b.payFetch.pay('http://seller.test/free')).status).toBe('not_required');
    expect(b.signer.signTypedData).not.toHaveBeenCalled();
  });
});

describe('plain payFetch keeps its behaviour and hands over the pending payment', () => {
  it('returns the 503 response and calls onPaymentPending', async () => {
    const pendings: PendingPayment[] = [];
    const s = seller(facilitator(['pending', 'pending', 'success']).client);
    const b = buyer(s.app, { onPaymentPending: (p) => pendings.push(p) });
    const res = await b.payFetch(URL_PAID);
    expect(res.status).toBe(503);
    expect(pendings).toHaveLength(1);
    expect(pendings[0]).toMatchObject({ status: 'pending', transaction: TX });
    expect(Object.keys(pendings[0].paymentHeaders).map((k) => k.toLowerCase())).toEqual(['payment-signature']);
    const done = expectStatus(await b.payFetch.resume(pendings[0], { ...FAST, client: chain().client }), 'settled');
    expect(done.delivered).toBe(true);
    expectSamePayment(b);
  });

  it('still throws on a lost response, after handing over the record', async () => {
    const pendings: PendingPayment[] = [];
    const b = buyer(seller(facilitator(['success']).client).app, { lose: () => true, onPaymentPending: (p) => pendings.push(p) });
    await expect(b.payFetch(URL_PAID)).rejects.toThrow(TypeError);
    expect(pendings.map((p) => p.status)).toEqual(['unknown']);
  });

  it('a 402 carrying a pending receipt (upstream adapters) is payment_rejected with details.pending', async () => {
    // What x402 core answers through @x402/express & co.: a 402 whose PAYMENT-RESPONSE reports the pending settlement.
    const receipt = Buffer.from(JSON.stringify({ success: false, errorReason: 'settlement_pending', transaction: TX, network: NETWORK.network, payer: BUYER.address })).toString('base64');
    const s = seller(facilitator(['success']).client);
    const app = async (request: Request) => (request.headers.has('payment-signature') ? new Response('{}', { status: 402, headers: { 'PAYMENT-RESPONSE': receipt } }) : s.app(request));
    const b = buyer(app);
    const error = await b.payFetch(URL_PAID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RadiusPaymentError);
    expect((error as RadiusPaymentError).code).toBe('payment_rejected');
    expect(((error as RadiusPaymentError).details as PaymentRejectedDetails).pending).toMatchObject({ status: 'pending', transaction: TX });
    expectStatus(await b.payFetch.pay(URL_PAID), 'pending');
  });
});

describe('upstream adapters', () => {
  it('@x402/express answers a pending settlement with 402 (x402 core); onSettlement still fires and the buyer still resumes', async () => {
    const { paymentMiddleware } = await import('@x402/express');
    const express = (await import('express')).default;
    const fac = facilitator(['pending', 'pending', 'success']);
    const outcomes: string[] = [];
    const radius = createRadiusServer({ network: NETWORK, facilitator: fac.client, settle: 'before', onSettlement: (o) => {
      outcomes.push(o.status);
    } });
    const app = express();
    app.use(paymentMiddleware(radius.routes({ payTo: PAY_TO, routes: { 'GET /api/report': '0.001' } }), radius.server));
    app.get('/api/report', (_req, res) => {
      res.json({ report: 'CONTENT' });
    });
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/report`;
      const b = buyer((request) => fetch(request));
      const first = expectStatus(await b.payFetch.pay(url), 'pending');
      expect(first.response?.status).toBe(402);
      expect(first.pending.transaction).toBe(TX);
      const done = expectStatus(await b.payFetch.resume(first.pending, { ...FAST, client: chain().client }), 'settled');
      expect(await done.response!.json()).toEqual({ report: 'CONTENT' });
      expect(outcomes).toEqual(['pending', 'settled']);
      expectSamePayment(b);
    } finally {
      server.close();
    }
  });
});
