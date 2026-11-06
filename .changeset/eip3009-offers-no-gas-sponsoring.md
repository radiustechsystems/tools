---
'radius-sdk': patch
---

Sellers no longer declare `eip2612GasSponsoring` in a 402 whose offers are all EIP-3009 (the Radius default since 0.4.0): EIP-3009 needs no approval, so there is nothing to sponsor. The declaration stays when the 402 carries a Permit2 offer whose facilitator supports sponsoring, and `gasSponsoring: true` now forces it only for Permit2 offers. Buyers see `PaymentOffer.gasSponsored: false` for such offers; payments are unchanged.
