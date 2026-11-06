/**
 * Settlement outcomes shared by the seller and the buyer. Pure: no viem, no x402 runtime imports,
 * so the root entry point and the seller can use it.
 */

/**
 * `errorReason` of a settle response whose transaction was broadcast (or is being settled) but has
 * no final result yet. It is the value `@x402/core` (`settleWithPendingRetry`) and `@x402/evm`
 * facilitators use: a pending response normally names the broadcast transaction, and presenting
 * the identical payment again settles against that transaction rather than a second one.
 */
export const SETTLEMENT_PENDING_REASON = 'settlement_pending';

/**
 * `errorReason` radius-sdk uses for a settlement with no authoritative answer at all (a timeout or
 * dropped connection after the settle request was sent). Facilitators do not send it.
 */
export const SETTLEMENT_UNKNOWN_REASON = 'settlement_unknown';

/**
 * Where a signed payment stands. More values may be added later; treat a value you do not
 * recognise as `unknown`.
 *
 * Terminal (`isTerminalSettlement`): the payment will not change state by waiting.
 * - `settled`: funds moved for this payment: the seller or facilitator reports success, or the
 *   chain shows the settlement transaction or the consumed authorization.
 * - `rejected`: refused before any settlement transaction was submitted (invalid signature, short
 *   balance, wrong amount, expired authorization). Nothing moved.
 * - `failed`: settlement was attempted and definitively moved nothing: its transaction reverted, or
 *   the authorization expired without being used.
 *
 * Retryable: present the **same** signed payment again; never sign a new one for this purchase.
 * - `pending`: settlement was submitted and has no final result yet.
 * - `unknown`: no authoritative answer: a timeout, a lost response, a gateway error, or a receipt
 *   that could not be trusted. The payment may or may not have settled.
 */
export type SettlementStatus = 'settled' | 'pending' | 'unknown' | 'rejected' | 'failed';

/** The fields of a settle response (or a decoded `PAYMENT-RESPONSE`) that classification reads. */
export interface SettleResponseLike {
  success: boolean;
  errorReason?: string;
  /** Settlement transaction hash; empty or absent when none was submitted. */
  transaction?: string;
}

/**
 * Maps a facilitator's settle response to a `SettlementStatus`. The facilitator contract for
 * pending settlement is still being agreed; pass your own to `radiusPayments({ classifySettlement })`
 * or `createRadiusFetch({ classifySettlement })` when your facilitator signals it differently.
 * Transport failures (no response at all) never reach a classifier: they are always `unknown`.
 */
export type SettlementClassifier = (response: SettleResponseLike) => SettlementStatus;

/**
 * The default `SettlementClassifier`:
 *
 * | Settle response                                              | Status    |
 * | ------------------------------------------------------------ | --------- |
 * | `success: true`                                              | `settled` |
 * | `errorReason: 'settlement_pending'` (with or without a hash) | `pending` |
 * | `errorReason: 'settlement_unknown'`                          | `unknown` |
 * | any other failure that names a `transaction`                 | `failed`  |
 * | any other failure without a `transaction`                    | `rejected`|
 *
 * A `failed` response is the facilitator's report; buyers confirm it on chain (a transaction the
 * chain does not show as reverted is not treated as definitive).
 */
export const classifySettlement: SettlementClassifier = (response) => {
  if (response.success === true) return 'settled';
  if (response.errorReason === SETTLEMENT_PENDING_REASON) return 'pending';
  if (response.errorReason === SETTLEMENT_UNKNOWN_REASON) return 'unknown';
  return typeof response.transaction === 'string' && response.transaction.length > 0 ? 'failed' : 'rejected';
};

/** True for `settled`, `rejected` and `failed`; false for `pending`, `unknown` and values added later. */
export function isTerminalSettlement(status: SettlementStatus | (string & {})): boolean {
  return status === 'settled' || status === 'rejected' || status === 'failed';
}
