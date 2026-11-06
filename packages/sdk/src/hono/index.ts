import type { Context, Env, MiddlewareHandler } from 'hono';
import type { HTTPRequestContext } from '@x402/core/server';
import type { PaymentReceipt } from '../receipt.js';
import { RadiusServer, createPaymentHandler, requestOf, type PayTo as ServerPayTo, type RadiusServerOptions, type RouteSpec as ServerRouteSpec, type RouteSpecs, type SettlementOutcome } from '../server/index.js';

export { RadiusFacilitatorClient, SettlementUnknownError, staticSupported, withUnknownOutcomes, type FacilitatorOptions } from '../server/facilitator.js';
export { SETTLEMENT_PENDING_REASON, SETTLEMENT_UNKNOWN_REASON, classifySettlement, isTerminalSettlement } from '../outcome.js';
export type { SettlementStatus, SettlementClassifier, SettleResponseLike } from '../outcome.js';
export type { SettlementOutcome } from '../server/index.js';
export { RadiusExactScheme, type GasSponsoringMode, type SettleMode } from '../server/scheme.js';
export { RadiusServer, createRadiusServer, RequestAdapter, toReceipt, type RadiusServerOptions, type ServerNetwork } from '../server/index.js';
export { MppPayments, type MppServerOptions } from '../server/mpp.js';
export { proxyTo } from '../server/proxy.js';

export type PayTo<E extends Env> = ServerPayTo<Context<E>>;
export type RouteSpec<E extends Env = Env> = ServerRouteSpec<Context<E>>;

export interface RadiusPaymentsOptions<E extends Env = Env> extends Omit<RadiusServerOptions, 'onSettled' | 'onSettlement'> {
  /** Recipient of every payment (unless a route overrides it). May read `c.env`. */
  payTo: PayTo<E>;
  /**
   * Protected routes keyed "METHOD /path" (Hono-style `*` wildcards allowed, e.g.
   * "GET /api/*"). A bare price is shorthand for `{ price }`.
   */
  routes: RouteSpecs<Context<E>>;
  /** Called once per settled payment. */
  onSettled?: (receipt: PaymentReceipt, c: Context<E>) => void | Promise<void>;
  /** Called once per settlement attempt with its outcome (see `RadiusServerOptions.onSettlement`). */
  onSettlement?: (outcome: SettlementOutcome, c: Context<E>) => void | Promise<void>;
}

/** Hono context variable set for paid requests: `c.get('radiusPayment')`. */
export type RadiusPaymentVariables = { radiusPayment?: PaymentReceipt };

/**
 * Hono middleware that charges for routes with x402 payments (Radius by default). A thin wrapper
 * over the web-standard handler in `radius-sdk/server`: dynamic `payTo`/`price` and
 * `onSettled` receive the Hono context, and paid handlers can read the receipt with
 * `c.get('radiusPayment')` (when `settle` is 'before', the default).
 */
export function radiusPayments<E extends Env = Env>(options: RadiusPaymentsOptions<E>): MiddlewareHandler<E> {
  const { payTo, routes, onSettled, onSettlement, ...serverOptions } = options;
  const contexts = new WeakMap<Request, Context<E>>();
  const contextOf = (ctx: HTTPRequestContext | undefined): Context<E> => {
    const c = contexts.get(requestOf(ctx) as Request);
    if (!c) throw new Error('radius-sdk/hono: request was not served through this middleware');
    return c;
  };
  const radius = new RadiusServer({
    ...serverOptions,
    onSettled: onSettled && ((receipt, ctx) => onSettled(receipt, contextOf(ctx))),
    onSettlement: onSettlement && ((outcome, ctx) => onSettlement(outcome, contextOf(ctx))),
  });
  const handler = createPaymentHandler(radius, radius.buildRoutes({ payTo, routes }, contextOf));
  return async (c, next) => {
    contexts.set(c.req.raw, c);
    c.res = await handler(c.req.raw, async (_request, payment) => {
      if (payment) c.set('radiusPayment' as never, payment as never);
      await next();
      return c.res;
    });
  };
}
