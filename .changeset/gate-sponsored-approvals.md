---
"radius-sdk": minor
"radius-cli": patch
---

`createRadiusFetch` no longer signs a facilitator-sponsored raw `approve` (`erc20ApprovalGasSponsoring`: an unlimited Permit2 allowance) without asking. It now passes the same gate as the automatic Permit2 approval: `permit2Approval: 'never'` throws `approval_required`, and `onApprovalRequired` is called with `sponsored: 'erc20Approval'` and may decline. The raw approve is withheld from the signing scheme unless approved, so it cannot be signed on its own, including when the allowance read fails. `eip2612GasSponsoring` permits are signed per payment for the payment amount, so they are part of the payment and are not gated. `wallet pay` words its prompt and non-interactive refusal for the sponsored case; `-y` and `--approve-permit2` still allow it.
