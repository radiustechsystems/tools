---
'radius-sdk': minor
---

Check payment receipts against the offer, and keep reported charges apart from confirmed ones.

- `createRadiusFetch` now checks every x402 receipt against the offer it paid before calling `onPaid`: the network (a Radius receipt cannot satisfy a Base offer), the payer, the transaction format, and the scheme's amount rules. A mismatch throws `invalid_receipt` for `exact` and `upto` alike; `details` is now `{ reason, receipt, response }`, with the unread response. An undecodable `exact` header still means no receipt.
- A successful `upto` receipt that omits the charge no longer reports the authorized maximum: `amount` stays unset and `receipt.charge.evidence` is `'incomplete'`. A reported zero charge with no transaction is accepted (`evidence: 'zero'`).
- Receipts gain `asset`, `decimals` and `charge` (`{ scheme, authorized, reported, evidence }`). The `PAYMENT-RESPONSE` header is unchanged.
- New `validatePaymentReceipt(receipt, expected)` runs the same checks on a receipt you decode yourself.
- New `reconcilePayment(receipt, offer)` (from `radius-sdk/client`, and `payFetch.reconcilePayment`) checks the token, payer, recipient and amount on chain. It returns `confirmed`, `no_charge`, `mismatch`, `reverted`, or `unresolved` when the evidence is not available, together with the authorized, reported and confirmed amounts.
- The server's `toReceipt` adds the same fields, and no longer fills a missing `upto` amount with the maximum.
