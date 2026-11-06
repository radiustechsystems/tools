import { FacilitatorResponseError, HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server';
import { SettleError, VerifyError, type PaymentPayload, type PaymentRequirements, type SettleResponse, type SupportedResponse, type VerifyResponse } from '@x402/core/types';
import type { PaymentNetwork } from '../networks.js';

export interface FacilitatorOptions {
  /** Facilitator base URL. Defaults to the network's (Radius's own; x402.org on Base Sepolia); required on Base. */
  url?: string;
  /** Sent as `x-api-key` on verify/settle/supported. */
  apiKey?: string;
  /**
   * Default true: `/supported` is fetched from the facilitator on the first paid
   * request after each cold start, so facilitator changes propagate without an SDK
   * update. Set false to use the built-in answer for Radius (no network call before
   * the first 402; goes stale if the facilitator changes). Radius networks only.
   */
  live?: boolean;
  timeoutMs?: number;
}

/**
 * The `/supported` answer the Radius facilitators return for a Radius network: `exact` in SBC by
 * EIP-3009 (listed first, so offers use it) or Permit2, and sponsored EIP-2612 approvals.
 */
export function staticSupported(network: PaymentNetwork): SupportedResponse {
  if (!network.radius) throw new Error(`staticSupported: ${network.name} is not a Radius network; its facilitator's /supported must be fetched`);
  return {
    kinds: (['eip3009', 'permit2'] as const).map((assetTransferMethod) => ({
      x402Version: 2,
      scheme: 'exact',
      network: network.network,
      extra: { assetTransferMethod, name: network.asset.name, version: network.asset.version },
    })),
    extensions: ['eip2612GasSponsoring'],
    signers: {},
  };
}

/**
 * FacilitatorClient for a hosted x402 facilitator (the network's default: Radius's on Radius,
 * x402.org on Base Sepolia). Nothing runs at construction; the first `/supported` lookup happens
 * lazily at request time (Cloudflare Workers forbid I/O at module scope).
 */
export class RadiusFacilitatorClient implements FacilitatorClient {
  readonly url: string;
  private readonly http: HTTPFacilitatorClient;
  private readonly live: boolean;
  private readonly network: PaymentNetwork;

  constructor(network: PaymentNetwork, options: FacilitatorOptions = {}) {
    this.network = network;
    const url = options.url ?? network.facilitatorUrl;
    if (!url) throw new Error(`radius-sdk: no default facilitator for ${network.name}; pass facilitator: { url } (or a FacilitatorClient) for it`);
    this.url = url.replace(/\/+$/, '');
    this.live = options.live ?? true;
    if (!this.live && !network.radius) throw new Error(`radius-sdk: facilitator live: false is only available on Radius networks (got ${network.name})`);
    const auth = options.apiKey ? { 'x-api-key': options.apiKey } : undefined;
    this.http = new HTTPFacilitatorClient({
      url: this.url,
      timeoutMs: options.timeoutMs,
      createAuthHeaders: auth ? async () => ({ verify: auth, settle: auth, supported: auth }) : undefined,
    });
  }

  verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.http.verify(paymentPayload, paymentRequirements);
  }

  settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return this.http.settle(paymentPayload, paymentRequirements);
  }

  getSupported(): Promise<SupportedResponse> {
    return this.live ? this.http.getSupported() : Promise.resolve(staticSupported(this.network));
  }
}

/**
 * A settle call that failed without the facilitator's own answer: a timeout, a dropped connection,
 * or an error status whose body is not an x402 response. The settle request may have reached the
 * facilitator and the chain, so the outcome is `unknown`, not a rejection. It is a
 * `FacilitatorResponseError`, so x402 core and `radiusPayments` treat it as one (`502`).
 * `withUnknownOutcomes` throws it; the original error is its `cause`.
 */
export class SettlementUnknownError extends FacilitatorResponseError {
  readonly operation = 'settle' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'SettlementUnknownError';
    if (options && 'cause' in options) Object.defineProperty(this, 'cause', { value: options.cause, configurable: true, writable: true });
  }
}

/**
 * A facilitator call that fails without the facilitator's own answer (a network error, or an
 * error status whose body is not an x402 response) leaves the outcome unknown: a settle may
 * have reached the chain. @x402/core reports those as a `402`, which a buyer reads as "rejected,
 * nothing moved", so this rethrows them as `FacilitatorResponseError`, which `radiusPayments`
 * answers with `502`. The facilitator's own answers (`VerifyError`, `SettleError`) pass through.
 * A settle that fails this way, including on a `FacilitatorResponseError` (for example a timeout),
 * is rethrown as `SettlementUnknownError`, so the seller can tell an unknown settlement from a
 * failed `/verify` or `/supported`, where nothing was submitted.
 */
export function withUnknownOutcomes(facilitator: FacilitatorClient): FacilitatorClient {
  const call = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof VerifyError || error instanceof SettleError || error instanceof SettlementUnknownError) throw error;
      if (operation === 'settle') {
        const message = error instanceof Error ? error.message : String(error);
        throw new SettlementUnknownError(error instanceof FacilitatorResponseError ? message : `Facilitator settle failed: ${message}`, { cause: error });
      }
      if (error instanceof FacilitatorResponseError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new FacilitatorResponseError(`Facilitator ${operation} failed: ${message}`), { cause: error });
    }
  };
  return {
    verify: (payload, requirements) => call('verify', () => facilitator.verify(payload, requirements)),
    settle: (payload, requirements) => call('settle', () => facilitator.settle(payload, requirements)),
    getSupported: () => call('supported', () => facilitator.getSupported()),
  };
}
