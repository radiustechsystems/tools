---
"radius-sdk": minor
"radius-cli": patch
---

Add Radius to an x402 server you already run. `radiusFacilitators()`, `registerRadius()` and `assertRadiusSupported()` (from `radius-sdk/server`) put the Radius facilitators and the `exact` scheme on your own `x402ResourceServer`, for a pipeline that does its own verify, work and settle. `settle` is required there.

**Breaking for installs:** `@x402/core` and `@x402/evm` move from exact-pinned dependencies (`2.27.0`) to peer dependencies (`^2.27.0`), so your app and the SDK share one copy, and you can use a newer `2.x` (the tests also pass on 2.28.0). Install `@x402/core` yourself; `@x402/evm` is an optional peer needed only for `radius-sdk/client`. A project that relied on the SDK installing them must add them to its own `package.json`.

`settle: 'before'` (the default) never calls the facilitator's `/verify`: x402 core's `verifyPayment()` answers `isValid: true` without checking, and `/settle` validates. The docs and JSDoc now say so, and `RadiusExactScheme` exposes `settle` and logs a one-time warning when built without it. The default for `radiusPayments()` and `createRadiusServer()` does not change.

The README no longer says offers use Permit2: they use EIP-3009 unless a facilitator lists Permit2 first. The SDK's MPP covers the `evm` charge method only, not the Tempo method of `mppx`; the docs say so.

`radius-cli` declares `@x402/evm` itself, which it used to get through `radius-sdk`.
