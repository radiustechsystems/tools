import {
  FacilitatorResponseError,
  type FacilitatorClient,
  SETTLEMENT_OVERRIDES_HEADER,
  getFacilitatorResponseError,
  withPrivateCacheControl,
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
  type RouteConfig,
  type RoutesConfig,
} from '@x402/core/server';
import { decodePaymentResponseHeader } from '@x402/core/http';
import { SettleError, type PaymentPayload, type PaymentRequirements, type SettleResponse } from '@x402/core/types';
import { resolveNetwork, explorerTxUrl, isNetworkId, overridesOf, type Address, type NetworkInput, type NetworkOverrides, type PaymentNetwork } from '../networks.js';
import { resolvePrice, type Price } from '../amounts.js';
import { PAYMENT_RESPONSE_HEADER, type ChargeEvidence, type PaymentReceipt } from '../receipt.js';
import { SETTLEMENT_UNKNOWN_REASON, classifySettlement, type SettleResponseLike, type SettlementClassifier, type SettlementStatus } from '../outcome.js';
import { RadiusFacilitatorClient, SettlementUnknownError, withUnknownOutcomes, type FacilitatorOptions } from './facilitator.js';
import { RadiusExactScheme, type GasSponsoringMode, type SettleMode } from './scheme.js';
import { requestContext, requestOf } from './adapter.js';
import { MPP_RECEIPT_HEADER, MppPayments, type MppServerOptions, type MppVerification } from './mpp.js';

export { RadiusFacilitatorClient, SettlementUnknownError, staticSupported, withUnknownOutcomes, type FacilitatorOptions } from './facilitator.js';
export { SETTLEMENT_PENDING_REASON, SETTLEMENT_UNKNOWN_REASON, classifySettlement, isTerminalSettlement } from '../outcome.js';
export type { SettlementStatus, SettlementClassifier, SettleResponseLike } from '../outcome.js';
export { RadiusExactScheme, type GasSponsoringMode, type SettleMode } from './scheme.js';
export { RequestAdapter, requestContext, requestOf } from './adapter.js';
export { MppPayments, type MppServerOptions } from './mpp.js';
export { proxyTo } from './proxy.js';
export type { HTTPRequestContext, RoutesConfig, FacilitatorClient } from '@x402/core/server';

/** Recipient address, or a function of the request. */
export type PayTo<Ctx> = Address | ((ctx: Ctx) => Address | Promise<Address>);

export interface RouteSpec<Ctx> {
  /**
   * "$0.01", "0.01", 0.01 (USD, converted for each network's stablecoin), or { amount: "10000" }
   * atomic units of each network's asset.
   */
  price: Price | ((ctx: Ctx) => Price | Promise<Price>);
  description?: string;
  mimeType?: string;
  /** Seconds the signed payment stays valid. Default 300. */
  maxTimeoutSeconds?: number;
  /** Per-route recipient override. */
  payTo?: PayTo<Ctx>;
}

/**
 * Protected routes keyed "METHOD /path" (`*` wildcards allowed, e.g. "GET /api/*").
 * A bare price is shorthand for `{ price }`.
 */
export type RouteSpecs<Ctx> = Record<string, RouteSpec<Ctx> | Price>;

export interface RoutesOptions<Ctx> {
  /** Recipient of every payment (unless a route overrides it). */
  payTo: PayTo<Ctx>;
  routes: RouteSpecs<Ctx>;
}

/** One network a server accepts payment on, with the facilitator that settles it. */
export interface ServerNetwork {
  network: NetworkInput;
  /** Defaults to the network's facilitator (Radius's on Radius, x402.org on Base Sepolia); required on Base. */
  facilitator?: FacilitatorOptions | FacilitatorClient;
}

export interface RadiusServerOptions extends NetworkOverrides {
  /** The network to accept payment on: 'mainnet' (Radius, default), 'testnet', 'base', 'base-sepolia', or any `PaymentNetwork`. */
  network?: NetworkInput;
  /**
   * Several networks to accept payment on (instead of `network`): every route offers one payment
   * option per network, in this order. Give a network its own facilitator with
   * `{ network, facilitator }`; Base has no default, so it needs one. Top-level `facilitator`
   * and overrides (`rpcUrl`, `asset`, …) apply to the first network.
   */
  networks?: readonly (NetworkInput | ServerNetwork)[];
  /**
   * Which facilitator verifies and settles. Defaults to the network's (the Radius facilitator on
   * Radius). Pass `{ url, apiKey }` for another hosted facilitator, or your own
   * `FacilitatorClient` (from `@x402/core/server`) for a self-hosted one.
   */
  facilitator?: FacilitatorOptions | FacilitatorClient;
  /**
   * 'before' (default): settle on-chain, then run the handler — the handler only ever runs for
   * money already received. x402 core makes no separate `/verify` call; `/settle` validates.
   * 'after': `/verify`, run the handler, then `/settle` if it succeeded (x402's default flow).
   * See `SettleMode`.
   */
  settle?: SettleMode;
  /**
   * Also accept MPP (the HTTP `Payment` auth scheme, draft-httpauth-payment) for its `evm` charge
   * method: every 402 then carries a `WWW-Authenticate: Payment` challenge per network next to the
   * x402 offers, and a payer's EIP-3009 authorization is settled through the same facilitator.
   * Served by `radiusPayments()` (web-standard and Hono); the upstream framework adapters only
   * see x402.
   */
  mpp?: MppServerOptions;
  /**
   * Whether 402s declare `eip2612GasSponsoring` (lets first-time wallets pay without an
   * approval transaction). 'auto' (default): only when the facilitator supports it.
   */
  gasSponsoring?: GasSponsoringMode;
  /**
   * Called once per settled payment, whichever adapter served the request. `context`
   * is the x402 request context; `requestOf(context)` gives the `Request` when the
   * SDK's own adapter handled it.
   *
   * Records settlement, not delivery: with `settle: 'before'` it fires before the handler
   * runs, and the handler may still fail or return an error. Errors thrown here are logged
   * by x402 core, not surfaced to the buyer. Persist the receipt and the delivery outcome
   * separately so a paid 5xx (or an uncertain 502) can be reconciled before the buyer pays again.
   */
  onSettled?: (receipt: PaymentReceipt, context: HTTPRequestContext | undefined) => void | Promise<void>;
  /**
   * Called once per settlement attempt with its outcome, whichever adapter served the request:
   * `settled` (alongside `onSettled`), `pending`, `unknown`, `rejected` or `failed`. Use it to keep
   * pending and unknown payments for reconciliation. Errors thrown here are logged, not surfaced.
   */
  onSettlement?: (outcome: SettlementOutcome, context: HTTPRequestContext | undefined) => void | Promise<void>;
  /**
   * Maps the facilitator's settle response to a `SettlementStatus`; default `classifySettlement`
   * (`errorReason: 'settlement_pending'` is pending). Replace it if your facilitator signals a
   * pending settlement differently. Settle calls with no facilitator answer are always `unknown`.
   */
  classifySettlement?: SettlementClassifier;
  /** Seconds sent in `Retry-After` with a pending (`503`) or unknown (`502`) settlement. Default 2. */
  settlementRetryAfter?: number;
}

/**
 * One settlement attempt as the seller saw it. `status` follows `SettlementStatus`.
 *
 * `payment` is the buyer's signed authorization and the requirement it pays. It is bearer-like:
 * whoever holds it can submit it for settlement until it expires. Store it like a secret (for
 * example to reconcile a pending or unknown outcome), never log it, and delete it once the outcome
 * is final.
 */
export interface SettlementOutcome {
  status: SettlementStatus;
  /**
   * The settle result as a receipt (`charge.evidence` is `pending` for a pending result). For an
   * `unknown` outcome without a facilitator answer: `success: false`, `errorReason:
   * 'settlement_unknown'`, and no transaction.
   */
  receipt: PaymentReceipt;
  /** Whether settlement ran before or after the application handler. */
  phase: 'before-handler' | 'after-handler';
  payment: { payload: PaymentPayload; requirements: PaymentRequirements };
  /** The error x402 core reported, for a failed settle call. */
  error?: unknown;
}

const GAS_SPONSORING_DECLARATION = {
  eip2612GasSponsoring: {
    info: {
      description: 'The facilitator accepts EIP-2612 gasless Permit to `Permit2` canonical contract.',
      version: '1',
    },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        from: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
        asset: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
        spender: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
        amount: { type: 'string', pattern: '^[0-9]+$' },
        nonce: { type: 'string', pattern: '^[0-9]+$' },
        deadline: { type: 'string', pattern: '^[0-9]+$' },
        signature: { type: 'string', pattern: '^0x[a-fA-F0-9]+$' },
        version: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)*$' },
      },
      required: ['from', 'asset', 'spender', 'amount', 'nonce', 'deadline', 'signature', 'version'],
    },
  },
} as const;

function isFacilitatorClient(v: unknown): v is FacilitatorClient {
  return typeof v === 'object' && v !== null && typeof (v as FacilitatorClient).settle === 'function' && typeof (v as FacilitatorClient).getSupported === 'function';
}

/** Kinds reported through a scoped facilitator, so `assertRadiusSupported` can tell whose answer core kept. */
const radiusKinds = new WeakSet<object>();

/**
 * A facilitator that reports only `network`'s kinds. x402 core routes each network to the first
 * facilitator listing it, so without this a facilitator configured for one network (e.g. a
 * multi-chain one for Base) could capture another network that has its own.
 */
function scopedTo(network: PaymentNetwork, facilitator: FacilitatorClient, failures: Map<PaymentNetwork, string>): FacilitatorClient {
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: async () => {
      try {
        const supported = await facilitator.getSupported();
        failures.delete(network);
        const kinds = supported.kinds.filter((k) => k.network === network.network);
        for (const kind of kinds) radiusKinds.add(kind);
        return { ...supported, kinds };
      } catch (e) {
        failures.set(network, e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
  };
}

type ConfiguredNetwork = { network: PaymentNetwork; facilitator: FacilitatorClient; scheme: RadiusExactScheme };

/** A scheme and facilitator per network, with the schemes linked as peers. */
function configureNetworks(options: Pick<RadiusServerOptions, 'network' | 'networks' | 'facilitator' | 'gasSponsoring'> & NetworkOverrides & { settle: SettleMode }, failures: Map<PaymentNetwork, string>): ConfiguredNetwork[] {
  if (options.network !== undefined && options.networks !== undefined) throw new Error('radius-sdk: pass network or networks, not both');
  if (options.networks !== undefined && options.networks.length === 0) throw new Error('radius-sdk: networks is empty');
  const entries: ServerNetwork[] = (options.networks ?? [options.network]).map((e) => (isServerNetwork(e) ? e : { network: e as NetworkInput }));
  const configured = entries.map((entry, i) => {
    const network = i === 0 ? resolveNetwork(entry.network, overridesOf(options)) : resolveNetwork(entry.network);
    const choice = entry.facilitator ?? (i === 0 ? options.facilitator : undefined);
    const facilitator = scopedTo(network, withUnknownOutcomes(isFacilitatorClient(choice) ? choice : new RadiusFacilitatorClient(network, choice)), failures);
    const scheme = new RadiusExactScheme(network, options.settle, options.gasSponsoring ?? 'auto');
    return { network, facilitator, scheme };
  });
  const chains = new Set(configured.map((c) => c.network.chainId));
  if (chains.size !== configured.length) throw new Error('radius-sdk: a network is listed twice');
  const schemes = configured.map((c) => c.scheme);
  for (const scheme of schemes) scheme.peers = schemes;
  return configured;
}

/** The settle response inside a failed settle call: a `SettleError`, or a response object itself. */
function settleResponseOf(error: unknown): (SettleResponseLike & Partial<SettleResponse>) | undefined {
  if (error instanceof SettleError) {
    return { success: false, errorReason: error.errorReason, errorMessage: error.errorMessage, transaction: error.transaction ?? '', network: error.network ?? '', payer: error.payer };
  }
  if (typeof error === 'object' && error !== null && typeof (error as SettleResponseLike).success === 'boolean' && !(error instanceof Error)) {
    return error as SettleResponseLike & Partial<SettleResponse>;
  }
  return undefined;
}

function isServerNetwork(v: unknown): v is ServerNetwork {
  return typeof v === 'object' && v !== null && 'network' in v && !('chain' in v);
}

/**
 * Turn a facilitator settle result into the receipt handed to application code. Adds what the
 * protocol response leaves out: the asset and its decimals, and `charge`, which keeps the offered
 * amount apart from the charge the facilitator reported.
 */
export function toReceipt(
  r: SettleResponse,
  network: PaymentNetwork,
  requirements: { amount: string; scheme?: string; asset?: string },
  classify: SettlementClassifier = classifySettlement,
): PaymentReceipt {
  const transaction = r.transaction && r.transaction.length > 0 ? r.transaction : undefined;
  const scheme = requirements.scheme === 'upto' ? 'upto' : 'exact';
  const reported = typeof r.amount === 'string' ? r.amount : undefined;
  const evidence: ChargeEvidence = !r.success
    ? classify(r) === 'pending' ? 'pending' : 'failed'
    : reported === undefined
      ? scheme === 'exact' ? 'implied' : 'incomplete'
      : scheme === 'upto' && /^0+$/.test(reported) ? 'zero' : 'reported';
  const asset = requirements.asset ?? network.asset.address;
  return {
    success: r.success,
    protocol: 'x402',
    transaction,
    network: r.network,
    payer: r.payer,
    // `exact` settles precisely the requested amount; facilitators only report `amount`
    // for schemes (like `upto`) where it can differ. A missing `upto` amount stays missing.
    amount: reported ?? (r.success && scheme === 'exact' ? requirements.amount : undefined),
    errorReason: r.errorReason,
    errorMessage: r.errorMessage,
    explorerUrl: transaction ? explorerTxUrl(network, transaction) : undefined,
    asset,
    decimals: asset.toLowerCase() === network.asset.address.toLowerCase() ? network.asset.decimals : undefined,
    charge: { scheme, authorized: requirements.amount, reported, evidence },
  };
}

/**
 * x402 payments for any HTTP stack, on Radius by default and optionally other networks. Holds the
 * x402 resource server (a scheme and facilitator per network, gas-sponsoring rules) independently
 * of how requests arrive:
 *
 * - `server` + `routes()` plug into the upstream adapters (`@x402/express`,
 *   `@x402/next`, `@x402/hono`): `paymentMiddleware(radius.routes({...}), radius.server)`.
 * - `handler()` serves web-standard `Request` → `Response` directly (Workers, Bun,
 *   Deno, Node, route handlers). `radius-sdk/hono` wraps it for Hono.
 */
export class RadiusServer {
  /** The first (or only) network. */
  readonly network: PaymentNetwork;
  /** Every network routes offer payment on, in offer order. */
  readonly networks: readonly PaymentNetwork[];
  /** The first network's facilitator, wrapped so calls that fail without its own answer surface as 502 (`withUnknownOutcomes`). */
  readonly facilitator: FacilitatorClient;
  /** The first network's scheme. */
  readonly scheme: RadiusExactScheme;
  /** The x402 resource server, for upstream framework adapters. */
  readonly server: x402ResourceServer;
  /** Networks whose facilitator's last `/supported` call failed, with the error. */
  private readonly supportedFailures: Map<PaymentNetwork, string>;
  /** MPP alongside x402, when `mpp` is configured. */
  readonly mpp?: MppPayments;
  /** Settle 'before' or 'after' the handler. */
  readonly settleMode: SettleMode;
  /** Maps settle responses to a `SettlementStatus` (`RadiusServerOptions.classifySettlement`). */
  readonly classifySettlement: SettlementClassifier;
  /** `Retry-After` seconds for pending and unknown settlements. */
  readonly settlementRetryAfter: number;
  private readonly facilitators: ReadonlyMap<PaymentNetwork, FacilitatorClient>;
  private readonly settledHooks: NonNullable<RadiusServerOptions['onSettled']>[] = [];
  private readonly settlementHooks: NonNullable<RadiusServerOptions['onSettlement']>[] = [];

  constructor(options: RadiusServerOptions = {}) {
    const supportedFailures = (this.supportedFailures = new Map());
    const configured = configureNetworks({ ...options, settle: options.settle ?? 'before' }, supportedFailures);
    this.networks = configured.map((c) => c.network);
    const [first] = configured;
    this.network = first.network;
    this.facilitator = first.facilitator;
    this.scheme = first.scheme;
    this.facilitators = new Map(configured.map((c) => [c.network, c.facilitator]));
    this.settleMode = options.settle ?? 'before';
    if (options.mpp) this.mpp = new MppPayments(this, options.mpp);
    this.server = new x402ResourceServer(configured.map((c) => c.facilitator));
    for (const { network, scheme } of configured) this.server.register(network.network, scheme);
    this.classifySettlement = options.classifySettlement ?? classifySettlement;
    const retryAfter = options.settlementRetryAfter ?? 2;
    if (!Number.isFinite(retryAfter) || retryAfter < 0) throw new Error('radius-sdk: settlementRetryAfter must be a non-negative number of seconds');
    this.settlementRetryAfter = Math.ceil(retryAfter);
    if (options.onSettled) this.onSettled(options.onSettled);
    if (options.onSettlement) this.onSettlement(options.onSettlement);
  }

  /** Why some networks' facilitators could not be reached for `/supported`, if any did not answer. @internal */
  unsupportedNetworks(): string | undefined {
    if (this.supportedFailures.size === 0) return undefined;
    return [...this.supportedFailures].map(([n, error]) => `${n.name}: ${error}`).join('; ');
  }

  /** The configured network a CAIP-2 id (or x402 v1 name) refers to; the first network if none matches. */
  networkFor(id: string | undefined): PaymentNetwork {
    return (id !== undefined ? this.networks.find((n) => isNetworkId(n, id)) : undefined) ?? this.network;
  }

  /** Register a settlement listener (see `RadiusServerOptions.onSettled`). */
  onSettled(hook: NonNullable<RadiusServerOptions['onSettled']>): this {
    if (this.settledHooks.length === 0) {
      this.server.onAfterSettle(async (ctx) => {
        if (!ctx.result.success) return;
        const transport = ctx.transportContext as { request?: HTTPRequestContext } | undefined;
        const receipt = toReceipt(ctx.result as SettleResponse, this.networkFor(ctx.requirements.network), ctx.requirements);
        await this.notifySettled(receipt, transport?.request);
      });
    }
    this.settledHooks.push(hook);
    return this;
  }

  /**
   * Register a listener for every settlement attempt's outcome (see `RadiusServerOptions.onSettlement`).
   * Fed by x402 core's settle hooks, so it also fires under upstream adapters (`@x402/express`).
   */
  onSettlement(hook: NonNullable<RadiusServerOptions['onSettlement']>): this {
    if (this.settlementHooks.length === 0) {
      const transportOf = (ctx: { transportContext?: unknown }) => (ctx.transportContext as { request?: HTTPRequestContext } | undefined)?.request;
      const paymentOf = (ctx: { paymentPayload: unknown; requirements: unknown }) => ({
        payload: ctx.paymentPayload as PaymentPayload,
        requirements: ctx.requirements as PaymentRequirements,
      });
      this.server.onAfterSettle(async (ctx) => {
        if (ctx.phase === 'cancel' || !ctx.result.success) return;
        const requirements = ctx.requirements as PaymentRequirements;
        const receipt = toReceipt(ctx.result as SettleResponse, this.networkFor(requirements.network), requirements, this.classifySettlement);
        await this.notifySettlement({ status: 'settled', receipt, phase: ctx.phase, payment: paymentOf(ctx) }, transportOf(ctx));
      });
      this.server.onSettleFailure(async (ctx) => {
        if (ctx.phase === 'cancel') return;
        const requirements = ctx.requirements as PaymentRequirements;
        const outcome = this.settlementOutcome(ctx.error, requirements, ctx.phase);
        await this.notifySettlement({ ...outcome, payment: paymentOf(ctx), error: ctx.error }, transportOf(ctx));
      });
    }
    this.settlementHooks.push(hook);
    return this;
  }

  /**
   * Classify a failed settle call: x402 core reports a settle response with `success: false`, or the
   * facilitator's own rejection, as a `SettleError`; anything else had no facilitator answer. @internal
   */
  settlementOutcome(error: unknown, requirements: PaymentRequirements, phase: SettlementOutcome['phase']): Pick<SettlementOutcome, 'status' | 'receipt' | 'phase'> {
    const network = this.networkFor(requirements.network);
    const settle = settleResponseOf(error);
    if (settle) {
      const response = { ...settle, network: settle.network || requirements.network } as SettleResponse;
      return { status: this.classifySettlement(response), receipt: toReceipt(response, network, requirements, this.classifySettlement), phase };
    }
    const message = error instanceof Error ? error.message : String(error);
    const unknown = { success: false, errorReason: SETTLEMENT_UNKNOWN_REASON, errorMessage: message, transaction: '', network: requirements.network } as SettleResponse;
    return { status: 'unknown', receipt: toReceipt(unknown, network, requirements, this.classifySettlement), phase };
  }

  /** Run every outcome listener, each isolated. @internal */
  async notifySettlement(outcome: SettlementOutcome, context: HTTPRequestContext | undefined): Promise<void> {
    for (const hook of this.settlementHooks) {
      try {
        await hook(outcome, context);
      } catch (e) {
        console.error('radius-sdk onSettlement hook failed:', e);
      }
    }
  }

  /** Run every settlement listener, each isolated: one that throws is logged and the rest still run. @internal */
  async notifySettled(receipt: PaymentReceipt, context: HTTPRequestContext | undefined): Promise<void> {
    for (const hook of this.settledHooks) {
      try {
        await hook(receipt, context);
      } catch (e) {
        console.error('radius-sdk onSettled hook failed:', e);
      }
    }
  }

  /** The facilitator (wrapped, see `facilitator`) that settles payments on `network`. */
  facilitatorFor(network: PaymentNetwork): FacilitatorClient {
    const f = this.facilitators.get(network);
    if (!f) throw new Error(`radius-sdk: ${network.name} is not one of this server's networks`);
    return f;
  }

  /**
   * x402 `RoutesConfig`: one payment option per network (USD prices converted for each network's
   * asset, or atomic amounts) and the gas-sponsoring declaration. Dynamic `payTo`/`price` receive
   * the x402 request context.
   */
  routes(options: RoutesOptions<HTTPRequestContext>): RoutesConfig {
    return this.buildRoutes(options, (ctx) => ctx);
  }

  /** `routes()` with dynamic functions receiving a framework-specific context. @internal */
  buildRoutes<Ctx>(options: RoutesOptions<Ctx>, contextOf: (ctx: HTTPRequestContext) => Ctx): RoutesConfig {
    const { networks } = this;
    const resolvePayTo = (spec: PayTo<Ctx>) => (typeof spec === 'function' ? (ctx: HTTPRequestContext) => spec(contextOf(ctx)) : spec);
    const normalise = (p: Price, network: PaymentNetwork) => {
      if (networks.length > 1 && typeof p === 'object' && p !== null && p.asset !== undefined) {
        throw new Error('radius-sdk: a price naming an asset cannot apply to several networks; give a USD price or an atomic amount without asset');
      }
      return resolvePrice(p, network.asset);
    };
    const routes: RoutesConfig = {};
    for (const [pattern, specOrPrice] of Object.entries(options.routes)) {
      const spec: RouteSpec<Ctx> =
        typeof specOrPrice === 'object' && specOrPrice !== null && 'price' in specOrPrice ? (specOrPrice as RouteSpec<Ctx>) : { price: specOrPrice as Price };
      const price = spec.price;
      const payTo = resolvePayTo(spec.payTo ?? options.payTo);
      const accepts = networks.map((network) => ({
        scheme: 'exact',
        network: network.network,
        payTo,
        price: typeof price === 'function' ? async (ctx: HTTPRequestContext) => normalise(await price(contextOf(ctx)), network) : normalise(price, network),
        maxTimeoutSeconds: spec.maxTimeoutSeconds ?? 300,
      }));
      const route: RouteConfig & { extensions?: Record<string, unknown> } = {
        accepts: accepts.length === 1 ? accepts[0] : accepts,
        description: spec.description,
        mimeType: spec.mimeType,
        extensions: { ...GAS_SPONSORING_DECLARATION },
      };
      routes[pattern] = route;
    }
    return routes;
  }

  /** An `x402HTTPResourceServer` for these routes (`paymentMiddlewareFromHTTPServer` in upstream adapters). */
  http(options: RoutesOptions<HTTPRequestContext>): x402HTTPResourceServer {
    return new x402HTTPResourceServer(this.server, this.routes(options));
  }

  /** Web-standard handler for these routes; dynamic `payTo`/`price` receive the `Request`. */
  handler(options: RoutesOptions<Request>): PaymentHandler {
    return createPaymentHandler(this, this.buildRoutes(options, (ctx) => requestOf(ctx) ?? missingRequest()));
  }
}

function missingRequest(): never {
  throw new Error('radius-sdk: request context was not produced by RequestAdapter');
}

export function createRadiusServer(options: RadiusServerOptions = {}): RadiusServer {
  return new RadiusServer(options);
}

/**
 * Radius for an x402 resource server you already run, where your code owns the verify, work and
 * settle steps. Use `radiusFacilitators`, `registerRadius` and `assertRadiusSupported` together.
 */
export interface RadiusRegistration {
  /** Networks to add, default Radius mainnet. Give a network its own facilitator with `{ network, facilitator }`; Base needs one. */
  networks?: readonly (NetworkInput | ServerNetwork)[];
  /**
   * Required, because it decides whether x402 core calls `/verify`: `'before'` skips it (core's
   * `verifyPayment()` answers `isValid: true` without checking; `/settle` validates), `'after'`
   * verifies, lets your handler run, then settles. A pipeline that verifies, works and then
   * settles needs `'after'`. See `SettleMode`.
   */
  settle: SettleMode;
  /** See `RadiusServerOptions.gasSponsoring`. */
  gasSponsoring?: GasSponsoringMode;
}

/**
 * The Radius facilitators to put **first** in the list you give `new x402ResourceServer(...)`:
 * core sends a network to the first facilitator that lists it, and these are scoped to their own
 * network. Core cannot add facilitators to a server that exists, so build this list first.
 */
export function radiusFacilitators(options: RadiusRegistration): FacilitatorClient[] {
  return configureNetworks(options, new Map()).map((c) => c.facilitator);
}

/** Register Radius's `exact` scheme for each network on `server`, built with `settle` (see `RadiusRegistration`). Returns `server`. */
export function registerRadius(server: x402ResourceServer, options: RadiusRegistration): x402ResourceServer {
  for (const { network, scheme } of configureNetworks(options, new Map())) server.register(network.network, scheme);
  return server;
}

/**
 * Throw unless a facilitator from `radiusFacilitators` reported supporting `exact` on every
 * network, after `server.initialize()`. Core skips a facilitator it cannot reach while another
 * answers, which would leave Radius offered in 402s but unable to settle, or settled by a
 * facilitator that is not the one you configured. Only facilitators from `radiusFacilitators`
 * count: a network answered by another facilitator in your list fails the check too.
 */
export function assertRadiusSupported(server: x402ResourceServer, options: RadiusRegistration): void {
  for (const { network } of configureNetworks(options, new Map())) {
    const kind = server.getSupportedKind(2, network.network, 'exact');
    if (!kind) throw new Error(`radius-sdk: no facilitator reported supporting exact payments on ${network.name} (${network.network})`);
    if (!radiusKinds.has(kind)) throw new Error(`radius-sdk: the Radius facilitator did not report ${network.name} (${network.network}), so another facilitator in the list answers for it; put radiusFacilitators(...) first and check that it is reachable`);
  }
}

/** The application handler behind a paid route. `payment` is set when settlement ran before the handler (`settle: 'before'`, the default). */
export type NextHandler = (request: Request, payment?: PaymentReceipt) => Response | Promise<Response>;

export interface PaymentHandler {
  /** Charge for `request` if it matches a paid route, then call `next` (or answer 402 / errors). */
  (request: Request, next: NextHandler): Promise<Response>;
  /** `handler => request => Response`, for runtimes that take a single fetch function. */
  wrap(next: NextHandler): (request: Request) => Promise<Response>;
  /** True when `request` matches a paid route (cheap, no network). */
  requiresPayment(request: Request): boolean;
  readonly radius: RadiusServer;
}

export interface RadiusPaymentsOptions extends Omit<RadiusServerOptions, 'onSettled' | 'onSettlement'>, RoutesOptions<Request> {
  /** Called once per settled payment with the `Request` that paid. */
  onSettled?: (receipt: PaymentReceipt, request: Request) => void | Promise<void>;
  /** Called once per settlement attempt with its outcome and the `Request` (see `RadiusServerOptions.onSettlement`). */
  onSettlement?: (outcome: SettlementOutcome, request: Request) => void | Promise<void>;
}

/**
 * Charge for routes with x402 payments (Radius by default; add networks with `networks`), for any
 * runtime that speaks web-standard `Request`/`Response`:
 *
 * ```ts
 * const pay = radiusPayments({ network: 'testnet', payTo: '0x…', routes: { 'GET /api/lookup': '$0.001' } });
 * export default { fetch: pay.wrap((request, payment) => Response.json({ paidBy: payment?.payer })) };
 * ```
 *
 * Standard x402 v2 on the wire: unpaid requests get a 402 with a `PAYMENT-REQUIRED`
 * header; paid requests carry `PAYMENT-SIGNATURE`, are verified and settled through
 * the facilitator, and get a `PAYMENT-RESPONSE` header back.
 */
export function radiusPayments(options: RadiusPaymentsOptions): PaymentHandler {
  const { payTo, routes, onSettled, onSettlement, ...serverOptions } = options;
  const radius = new RadiusServer({
    ...serverOptions,
    onSettled: onSettled && ((receipt, ctx) => onSettled(receipt, requestOf(ctx) ?? missingRequest())),
    onSettlement: onSettlement && ((outcome, ctx) => onSettlement(outcome, requestOf(ctx) ?? missingRequest())),
  });
  return radius.handler({ payTo, routes });
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function instructionsToResponse(r: HTTPResponseInstructions): Response {
  const res = r.isHtml ? new Response(String(r.body ?? ''), { status: r.status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } }) : jsonResponse(r.body ?? {}, r.status);
  for (const [k, v] of Object.entries(r.headers)) res.headers.set(k, v);
  return res;
}

function facilitatorErrorResponse(error: FacilitatorResponseError): Response {
  return jsonResponse({ error: 'facilitator_error', message: error.message }, 502);
}

const RETRY_SAME_PAYMENT = 'Send the same request with the same payment signature again later; do not sign a new payment for it.';

/**
 * `503`: settlement was submitted and has no final result. Keeps the facilitator's `PAYMENT-RESPONSE`
 * (`success: false`, `errorReason`, `transaction`) so a buyer can resume with the same payment.
 */
function settlementPendingResponse(retryAfter: number, settle: SettleResponseLike, paymentResponse?: string | null): Response {
  const transaction = settle.transaction || undefined;
  const res = jsonResponse({ error: 'settlement_pending', message: `Settlement of this payment is pending. ${RETRY_SAME_PAYMENT}`, transaction, retryAfter }, 503);
  if (paymentResponse) res.headers.set('PAYMENT-RESPONSE', paymentResponse);
  res.headers.set('Retry-After', String(retryAfter));
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/** `502` for a settle call with no authoritative answer: the payment may have settled. */
function settlementUnknownResponse(retryAfter: number, message: string, paymentResponse?: string | null): Response {
  const res = jsonResponse({ error: 'facilitator_error', message, settlement: 'unknown', retryAfter }, 502);
  if (paymentResponse) res.headers.set('PAYMENT-RESPONSE', paymentResponse);
  res.headers.set('Retry-After', String(retryAfter));
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

function internalErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ error: 'payment_processing_error', message }, 500);
}

function setHeaders(res: Response, headers: Record<string, string> | undefined): void {
  if (headers) for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
}

/**
 * A copy of `res` whose headers are mutable (responses from `fetch()` have immutable headers). The
 * Headers are copied explicitly: @hono/node-server's global `Response` keeps the object it is given.
 */
function mutable(res: Response, body: BodyInit | null = res.body): Response {
  return new Response(body, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) });
}

/** Web-standard handler for an already-built x402 `RoutesConfig` (see `RadiusServer.buildRoutes`). @internal */
export function createPaymentHandler(radius: RadiusServer, routes: RoutesConfig): PaymentHandler {
  const httpServer = new x402HTTPResourceServer(radius.server, routes);
  const retryAfter = radius.settlementRetryAfter;

  /** A 502 for facilitator failures; a settle with no answer also says `settlement: 'unknown'` and when to retry. */
  const facilitatorFailure = (error: FacilitatorResponseError): Response =>
    error instanceof SettlementUnknownError ? settlementUnknownResponse(retryAfter, error.message) : facilitatorErrorResponse(error);
  const errorResponse = (error: unknown): Response => {
    const fe = getFacilitatorResponseError(error);
    return fe ? facilitatorFailure(fe) : internalErrorResponse(error);
  };

  /**
   * x402 core answers every failed settlement with a 402 carrying the settle response in
   * `PAYMENT-RESPONSE`. A pending or unknown settlement is not a rejection: a 402 would tell the
   * buyer to pay again. Answer `503` (pending) or `502` (unknown) instead, keeping the header.
   */
  const settlementFailure = (res: Response): Response | undefined => {
    const header = res.status === 402 ? res.headers.get(PAYMENT_RESPONSE_HEADER) : null;
    if (!header) return undefined;
    let settle: SettleResponseLike & { errorMessage?: string };
    try {
      settle = decodePaymentResponseHeader(header);
    } catch {
      return undefined;
    }
    if (settle.success) return undefined;
    const status = radius.classifySettlement(settle);
    if (status === 'pending') return settlementPendingResponse(retryAfter, settle, header);
    if (status === 'unknown') return settlementUnknownResponse(retryAfter, settle.errorMessage ?? settle.errorReason ?? 'Settlement outcome unknown', header);
    return undefined;
  };

  // Lazy, request-time initialisation: Workers forbid I/O at module scope, and the static
  // facilitator answer means this is normally just bookkeeping anyway. A failure is not cached: the
  // next request tries again. When it failed because a facilitator's /supported did (x402 core
  // reports that as a route configuration error), answer 502 rather than 500.
  let initPromise: Promise<void> | undefined;
  const ensureInitialized = () =>
    (initPromise ??= httpServer.initialize().catch((e) => {
      initPromise = undefined;
      const unreachable = radius.unsupportedNetworks();
      throw unreachable ? Object.assign(new FacilitatorResponseError(unreachable), { cause: e }) : e;
    }));

  const { mpp } = radius;

  /** Pay with an MPP credential: verify against the route's x402 offers, settle per `settle`, attach `Payment-Receipt`. */
  const handleMpp = async (request: Request, context: HTTPRequestContext, x402Challenge: Response, next: NextHandler): Promise<Response> => {
    const m = mpp!;
    const failed = (f: Extract<MppVerification, { ok: false }>) =>
      f.status === 503
        ? settlementPendingResponse(retryAfter, f.settle ?? { success: false })
        : f.status === 502
          ? f.settle || f.error instanceof SettlementUnknownError
            ? settlementUnknownResponse(retryAfter, f.reason)
            : jsonResponse({ error: 'facilitator_error', message: f.reason }, 502)
          : m.rejection(request, x402Challenge, f.reason);
    /** Settle and report the outcome to `onSettlement` (MPP settles outside x402 core's hooks). */
    const settle = async (v: Extract<MppVerification, { ok: true }>, phase: SettlementOutcome['phase']) => {
      const settled = await m.settle(v);
      const payment = { payload: v.payload, requirements: v.requirements };
      const outcome: SettlementOutcome = settled.ok
        ? { status: 'settled', receipt: settled.receipt, phase, payment }
        : { ...radius.settlementOutcome(settled.settle ?? settled.error ?? new Error(settled.reason), v.requirements, phase), payment, error: settled.error };
      await radius.notifySettlement(outcome, context);
      return settled;
    };
    const verified = await m.verify(request, x402Challenge);
    if (!verified.ok) return failed(verified);

    const withReceipt = (res: Response, receipt: PaymentReceipt): Response => {
      const out = mutable(res);
      out.headers.set(MPP_RECEIPT_HEADER, m.receiptHeader(receipt));
      out.headers.set('Cache-Control', withPrivateCacheControl(out.headers.get('Cache-Control')));
      return out;
    };

    if (radius.settleMode === 'before') {
      const settled = await settle(verified, 'before-handler');
      if (!settled.ok) return failed(settled);
      await radius.notifySettled(settled.receipt, context);
      let res: Response;
      try {
        res = await next(request, settled.receipt);
      } catch (error) {
        // Paid but undelivered: the receipt goes back with the error so the buyer can reconcile.
        return withReceipt(internalErrorResponse(error), settled.receipt);
      }
      return withReceipt(res, settled.receipt);
    }

    const res = await next(request);
    if (res.status >= 400) return res;
    const settled = await settle(verified, 'after-handler');
    if (!settled.ok) return failed(settled);
    await radius.notifySettled(settled.receipt, context);
    return withReceipt(res, settled.receipt);
  };

  const handle = async (request: Request, next: NextHandler): Promise<Response> => {
    const context = requestContext(request);
    if (!httpServer.requiresPayment(context)) return next(request);

    try {
      await ensureInitialized();
    } catch (error) {
      return errorResponse(error);
    }

    let result: Awaited<ReturnType<typeof httpServer.processHTTPRequest>>;
    try {
      result = await httpServer.processHTTPRequest(context);
    } catch (error) {
      return errorResponse(error);
    }

    if (result.type === 'no-payment-required') return next(request);
    if (result.type === 'payment-error') {
      const res = instructionsToResponse(result.response);
      const unsettled = settlementFailure(res);
      if (unsettled) return unsettled;
      if (!mpp || res.status !== 402) return res;
      // No x402 payment: an MPP credential is checked against the offers this 402 lists; otherwise
      // the 402 also offers MPP.
      if (!context.paymentHeader && /^payment\s/i.test(request.headers.get('authorization') ?? '')) return handleMpp(request, context, res, next);
      return mpp.addChallenges(request, res);
    }

    const { cancellationDispatcher, beforeHandlerSettlement, paymentPayload, paymentRequirements, declaredExtensions } = result;
    const payment = beforeHandlerSettlement ? toReceipt(beforeHandlerSettlement.result, radius.networkFor(paymentRequirements.network), paymentRequirements) : undefined;

    let res: Response;
    try {
      res = await next(request, payment);
    } catch (error) {
      const cancelSettlement = await cancellationDispatcher.cancel({ reason: 'handler_threw', error: error as Error });
      if (!beforeHandlerSettlement && !cancelSettlement) throw error;
      const failure = internalErrorResponse(error);
      setHeaders(failure, httpServer.createFailurePathSettlementHeaders(cancelSettlement, beforeHandlerSettlement, paymentPayload, failure.headers.get('Cache-Control')));
      return failure;
    }

    if (res.status >= 400) {
      const cancelSettlement = await cancellationDispatcher.cancel({ reason: 'handler_failed', responseStatus: res.status });
      const failure = mutable(res);
      failure.headers.delete(SETTLEMENT_OVERRIDES_HEADER);
      setHeaders(failure, httpServer.createFailurePathSettlementHeaders(cancelSettlement, beforeHandlerSettlement, paymentPayload, failure.headers.get('Cache-Control')));
      return failure;
    }

    // Settlement already happened in the 'before' flow: core only echoes its headers, so the
    // handler's body streams through untouched. The 'after' flow settles on the finished
    // response and needs the body in hand.
    const responseBody = beforeHandlerSettlement ? undefined : new Uint8Array(await res.arrayBuffer());
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });
    try {
      const settleResult = await httpServer.processSettlement(
        paymentPayload,
        paymentRequirements,
        declaredExtensions,
        { request: context, responseBody, responseHeaders },
        undefined,
        beforeHandlerSettlement,
      );
      if (!settleResult.success) {
        const failure = instructionsToResponse(settleResult.response);
        return settlementFailure(failure) ?? failure;
      }
      const out = mutable(res, responseBody ?? res.body);
      setHeaders(out, settleResult.headers);
      out.headers.set('Cache-Control', withPrivateCacheControl(out.headers.get('Cache-Control')));
      out.headers.delete(SETTLEMENT_OVERRIDES_HEADER);
      return out;
    } catch (error) {
      if (error instanceof FacilitatorResponseError) return facilitatorFailure(error);
      console.error(error);
      return jsonResponse({ error: 'settlement_error' }, 402);
    }
  };

  const handler = handle as PaymentHandler;
  Object.defineProperties(handler, {
    radius: { value: radius, enumerable: true },
    wrap: { value: (next: NextHandler) => (request: Request) => handle(request, next), enumerable: true },
    requiresPayment: { value: (request: Request) => httpServer.requiresPayment(requestContext(request)), enumerable: true },
  });
  return handler;
}
