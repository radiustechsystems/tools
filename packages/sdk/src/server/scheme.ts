import type { AssetAmount, Network, PaymentRequirements, Price as X402Price, SchemeNetworkServer, SchemePaymentRequiredContext } from '@x402/core/types';
import { resolvePrice, type Price } from '../amounts.js';
import type { PaymentNetwork } from '../networks.js';

/**
 * When a payment settles relative to your handler, and with it whether x402 core calls the
 * facilitator's `/verify`:
 *
 * - `'before'` (the `upfront` payment flow): `/settle` verifies and settles in one call, then the
 *   handler runs, so it only ever runs for money already received. x402 core does **not** call
 *   `/verify`: `x402ResourceServer.verifyPayment()` returns `isValid: true` without checking the
 *   payment.
 * - `'after'` (the `authorization` payment flow, x402's default): `/verify` runs first (a dry run,
 *   no funds move), then the handler, then `/settle` if the handler succeeded. A failed handler
 *   costs the payer nothing.
 *
 * `radiusPayments()` and `createRadiusServer()` default to `'before'`. A server whose verify,
 * work and settle steps you drive yourself must say which it wants, because `'before'` skips
 * `/verify`.
 */
export type SettleMode = 'before' | 'after';
/** 'auto': declare gas sponsoring iff the facilitator's /supported lists it. */
export type GasSponsoringMode = 'auto' | boolean;

export const EIP2612_GAS_SPONSORING = 'eip2612GasSponsoring';

let warnedDefaultSettle = false;

/**
 * Server-side `exact` scheme for one network: prices in USD or its asset's atomic units, Permit2
 * or EIP-3009 transfer method, no dependency on @x402/evm (the facilitator does all the
 * cryptography). The transfer method is whichever the facilitator lists first for the network,
 * else EIP-3009 (x402's default, and what Base facilitators settle for USDC).
 *
 * `settle` picks the payment flow (see `SettleMode`). Omitting it means `'before'`, under which
 * x402 core never calls `/verify`; pass it explicitly, as a server with its own verify, work and
 * settle pipeline needs `'after'`.
 */
export class RadiusExactScheme implements SchemeNetworkServer {
  readonly scheme = 'exact';
  readonly defaultAssetTransferMethod = 'eip3009';
  /** The settle mode this scheme advertises: `'before'` is the `upfront` payment flow, `'after'` is `authorization`. */
  readonly settle: SettleMode;
  readonly paymentFlows: SchemeNetworkServer['paymentFlows'];
  /**
   * `paymentFlow` is a server-side hint (when to settle relative to the handler).
   * Clients are not required to echo it, so exclude it from accepted-vs-required
   * matching — stock radius-cli only echoes assetTransferMethod/name/version.
   */
  readonly dynamicExtraFields = ['paymentFlow'];

  private facilitatorExtensions: string[] | undefined;
  /**
   * Schemes of every network the server offers (this one included). The gas-sponsoring
   * declaration is shared by all offers in a 402, so it stays while any of them declares it.
   */
  peers: readonly RadiusExactScheme[] = [this];

  constructor(
    private readonly network: PaymentNetwork,
    settle?: SettleMode,
    private readonly gasSponsoring: GasSponsoringMode = 'auto',
  ) {
    if (settle === undefined && !warnedDefaultSettle) {
      warnedDefaultSettle = true;
      console.warn("radius-sdk: RadiusExactScheme defaults settle to 'before', so x402 core skips /verify. Pass 'before' or 'after' explicitly.");
    }
    this.settle = settle ?? 'before';
    // Both transfer methods a facilitator may list; the one it names first for the network
    // is what the 402 advertises.
    const flows: SchemeNetworkServer['paymentFlows'][string] = {
      supported: ['authorization', 'upfront'],
      default: this.settle === 'before' ? 'upfront' : 'authorization',
    };
    this.paymentFlows = { permit2: flows, eip3009: flows };
  }

  async parsePrice(price: X402Price, _network: Network): Promise<AssetAmount> {
    const { amount, asset } = resolvePrice(price as Price, this.network.asset);
    return { amount, asset, extra: {} };
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: { x402Version: number; scheme: string; network: Network; extra?: Record<string, unknown> },
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    this.facilitatorExtensions = extensionKeys;
    const kindExtra = supportedKind.extra ?? {};
    return {
      ...paymentRequirements,
      extra: {
        assetTransferMethod: kindExtra.assetTransferMethod ?? 'eip3009',
        name: kindExtra.name ?? this.network.asset.name,
        version: kindExtra.version ?? this.network.asset.version,
        ...paymentRequirements.extra,
      },
    };
  }

  /** True when 402 responses should declare `eip2612GasSponsoring`. */
  declaresGasSponsoring(): boolean {
    if (this.gasSponsoring !== 'auto') return this.gasSponsoring;
    return this.facilitatorExtensions?.includes(EIP2612_GAS_SPONSORING) ?? true;
  }

  /**
   * Routes declare gas sponsoring statically; strip the declaration when the
   * facilitator does not actually support it, so clients fall back to a normal
   * Permit2 approval instead of sending a permit nobody will honour.
   */
  enrichPaymentRequiredResponse = async (ctx: SchemePaymentRequiredContext): Promise<void> => {
    const ext = ctx.paymentRequiredResponse.extensions;
    if (ext && EIP2612_GAS_SPONSORING in ext && !this.peers.some((p) => p.declaresGasSponsoring())) {
      delete ext[EIP2612_GAS_SPONSORING];
      if (Object.keys(ext).length === 0) delete ctx.paymentRequiredResponse.extensions;
    }
  };
}
