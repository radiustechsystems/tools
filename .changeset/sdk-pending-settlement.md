---
'radius-sdk': minor
---

Recover a payment whose settlement is pending or unknown with the same signed authorization, instead of paying again.

- Typed outcomes: `SettlementStatus` is `settled`, `pending`, `unknown`, `rejected` or `failed`. `classifySettlement` maps a facilitator's settle response to one (`errorReason: 'settlement_pending'` is pending, as in `@x402/core` and `@x402/evm`), and `isTerminalSettlement` separates final outcomes from retryable ones. Pass your own classifier as `classifySettlement` to the server or the client when a facilitator signals pending settlement differently.
- New `payFetch.pay(input, init)` resolves with a `PaymentOutcome` instead of returning a bare response or throwing once a payment was signed. A `pending` or `unknown` outcome carries a `PendingPayment`: the original request, the offer, the signed payment headers and any settlement transaction.
- New `payFetch.resume(pending, options)` presents the same signed payment again, with bounded attempts, exponential backoff that honours `Retry-After`, a per-attempt timeout and an `AbortSignal`. It never signs a new payment, and aborting stops the wait, not the payment. Where it can, it checks the chain: a named transaction that reverted is `failed`; when the seller refuses the payment again, a consumed authorization is `settled` and one that expired unused is `failed`.
- `payFetch` itself behaves as before. The new `onPaymentPending` option receives the `PendingPayment` when a paid request ends pending or unknown, and a `payment_rejected` error whose 402 reports a pending settlement carries it as `details.pending`.
- Sellers (`radiusPayments`, Hono): a pending settlement now answers `503` with `Retry-After` and the facilitator's `PAYMENT-RESPONSE` instead of `402`, in both settle modes, so buyers do not read it as a rejection. A settle call with no facilitator answer still answers `502`, now with `settlement: 'unknown'` and `Retry-After`. Rejections and failures stay `402`. The `Retry-After` value is `settlementRetryAfter` (default 2 seconds).
- New `onSettlement(outcome, context)` server option and `radius.onSettlement(hook)` report every settlement attempt with its status, receipt, phase and the signed payment, also under upstream adapters.
- `withUnknownOutcomes` throws `SettlementUnknownError` (a `FacilitatorResponseError`) for a settle call with no facilitator answer.
- `ChargeEvidence` gains `'pending'`, and `reconcilePayment` checks a failure receipt that names a transaction on chain instead of answering `unresolved`.
