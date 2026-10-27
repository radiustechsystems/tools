# radius-cli

## 0.6.0

### Minor Changes

- 118203d: `createRadiusFetch` and `wallet pay` handle redirects around a payment. A request whose 402 follows a redirect (fetch follows it, up to its limit of 20) is paid at the final URL, repeating the original method and body, as `@x402/fetch` and `@x402/axios` do. A redirect after payment is followed without the payment header, and the receipt is taken from its `PAYMENT-RESPONSE`. `redirect_refused` is no longer raised.

### Patch Changes

- c528b33: Add Radius to an x402 server you already run. `radiusFacilitators()`, `registerRadius()` and `assertRadiusSupported()` (from `radius-sdk/server`) put the Radius facilitators and the `exact` scheme on your own `x402ResourceServer`, for a pipeline that does its own verify, work and settle. `settle` is required there.
  
  **Breaking for installs:** `@x402/core` and `@x402/evm` move from exact-pinned dependencies (`2.27.0`) to peer dependencies (`^2.27.0`), so your app and the SDK share one copy, and you can use a newer `2.x` (the tests also pass on 2.28.0). Install `@x402/core` yourself; `@x402/evm` is an optional peer needed only for `radius-sdk/client`. A project that relied on the SDK installing them must add them to its own `package.json`.
  
  `settle: 'before'` (the default) never calls the facilitator's `/verify`: x402 core's `verifyPayment()` answers `isValid: true` without checking, and `/settle` validates. The docs and JSDoc now say so, and `RadiusExactScheme` exposes `settle` and logs a one-time warning when built without it. The default for `radiusPayments()` and `createRadiusServer()` does not change.
  
  The README no longer says offers use Permit2: they use EIP-3009 unless a facilitator lists Permit2 first. The SDK's MPP covers the `evm` charge method only, not the Tempo method of `mppx`; the docs say so.
  
  `radius-cli` declares `@x402/evm` itself, which it used to get through `radius-sdk`.
- 8388099: `createRadiusFetch` no longer signs a facilitator-sponsored raw `approve` (`erc20ApprovalGasSponsoring`: an unlimited Permit2 allowance) without asking. It now passes the same gate as the automatic Permit2 approval: `permit2Approval: 'never'` throws `approval_required`, and `onApprovalRequired` is called with `sponsored: 'erc20Approval'` and may decline. The raw approve is withheld from the signing scheme unless approved, so it cannot be signed on its own, including when the allowance read fails. `eip2612GasSponsoring` permits are signed per payment for the payment amount, so they are part of the payment and are not gated. `wallet pay` words its prompt and non-interactive refusal for the sponsored case; `-y` and `--approve-permit2` still allow it.
- Updated dependencies [c528b33]
- Updated dependencies [118203d]
- Updated dependencies [8388099]
- Updated dependencies [4ed2dfd]
  - radius-sdk@0.7.0

## 0.5.0

### Minor Changes

- cc68f37: Add `network`: print the resolved network config (chain id, RPC, explorer, faucet, facilitator, SBC) as text or `--json`, without touching the network.
- 98450dd: Add `wallet sign-typed-data` (EIP-712) and `wallet sign-jwt` (ES256K), so agents can sign with the local account without exporting the private key.
- ef5d91d: Add `wallet faucet`: request a faucet drip for the local account (testnet ~0.5 SBC, mainnet ~0.01 SBC/day), with `--json` output.
- 3fb56ac: `sell check <url>` checks a seller's `402` without paying: it decodes the x402 `PAYMENT-REQUIRED` offers and any MPP `WWW-Authenticate: Payment` challenge, checks each offer's network, asset and EIP-712 domain, amount (against `--price`, at the asset's decimals), `payTo`, `resource.url` and `maxTimeoutSeconds`, reads the facilitator's `/supported` (`--facilitator`, default the network's) for each offer's scheme, network and transfer method, and asks the SDK buyer whether it would pay. `--probe-head` warns when an unpaid `HEAD` is served, and `--pay --threshold` makes one paid request (testnet unless `--network mainnet`) and checks the receipt. Like the SDK buyer it also reads an x402 challenge from the JSON body, and a malformed offer is a failed check, not a crash. Prints a checklist or, with `--json`, a report; exits 1 when a check fails and 2 on invalid flags.

### Patch Changes

- 8175dda: Package metadata points at the renamed repository, github.com/radiustechsystems/tools.
- Updated dependencies [8175dda]
- Updated dependencies [67ea7ce]
- Updated dependencies [726a7a8]
  - radius-sdk@0.6.0

## 0.4.0

### Minor Changes

- 25eb09d: `wallet pay` also pays MPP (`WWW-Authenticate: Payment`, `evm` charges). `--protocol auto|x402|mpp` (default `auto`: x402 when a server offers both) chooses, and the JSON `payment` object gains `protocol`. Messages are now prefixed `pay:` instead of `x402:`.
- 8f4900a: `wallet x402` is renamed `wallet pay` and can pay in USDC on Base: `--networks radius,base` (or `RADIUS_PAY_NETWORKS` / `payNetworks` in the config file) lists the networks to pay on, in preference order (the first one the wallet can cover wins), and `--network testnet` pairs Radius testnet with Base Sepolia. Base RPCs are set with `RADIUS_BASE_RPC_URL` / `RADIUS_BASE_SEPOLIA_RPC_URL` or `rpcUrls.base` / `rpcUrls["base-sepolia"]`. `--x402-threshold` and `--x402-approve-permit2` are renamed `--threshold` and `--approve-permit2`, prompts and messages name the network and its token, and the JSON `payment` object gains `network`.
- 8c8c671: Require Node 22 or later. Node 20 reached end of life on 30 April 2026.

### Patch Changes

- Updated dependencies [8c8c671]
- Updated dependencies [25eb09d]
- Updated dependencies [8f4900a]
  - radius-sdk@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [23f73d6]
- Updated dependencies [5a915b2]
- Updated dependencies [bdd6d76]
  - radius-sdk@0.4.0

## 0.3.0

### Minor Changes

- ba3f6c1: `wallet` runs its ERC-20 interactions on `radius-sdk/client`'s `erc20Actions` and balance actions. `wallet send <to> <amount> 0xToken` transfers any ERC-20 (decimals read on-chain), next to `SBC` and `RUSD`. `wallet balance` now reports native RUSD and SBC separately instead of adding SBC to the aggregate `eth_getBalance` (which already includes it), so `totalUsd` no longer double counts; the JSON gains `aggregateWei` and `rusdSource`.

### Patch Changes

- Updated dependencies [c504f65]
  - radius-sdk@0.3.0

## 0.2.1

### Patch Changes

- fd86bf6: README: SBC has a built-in default address (from `radius-sdk`); `--sbc` / `RADIUS_SBC_ADDRESS` are only needed for another deployment.
- Updated dependencies [fd86bf6]
- Updated dependencies [2dae8ec]
  - radius-sdk@0.2.0

## 0.2.0

### Minor Changes

- ed17f69: `wallet x402` now pays through `radius-sdk`: Permit2 approvals are gas-sponsored when the server declares `eip2612GasSponsoring`, payments are in SBC only on the configured network, the keystore is unlocked only after a 402 has been parsed and matched, and `--x402-approve-permit2` grants an approval even when sponsored. `--x402-threshold` is now a hard cap even with `--yes`: an offer above it is refused (exit 2) instead of paid; drop the threshold to let `--yes` pay any amount. The hand-rolled x402 client is gone.

### Patch Changes

- 129d8cc: Point the package's `repository`, `homepage` and `bugs` metadata at github.com/radiustechsystems/radius-cli (it named a non-existent `radiustech` org). npm provenance requires `repository.url` to match the repository the package is published from.
- Updated dependencies [94add33]
- Updated dependencies [d966811]
  - radius-sdk@0.1.0
