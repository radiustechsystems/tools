# radius-sdk (Python)

This package is versioned on its own; it is not part of the npm Changesets release flow.

## 0.1.0

First release: a port of the TypeScript `radius-sdk` 0.6.0.

- `radius_sdk`: networks (Radius mainnet and testnet, Base, Base Sepolia, `define_payment_network`), amounts, receipts, `RadiusPaymentError` codes, `radius_env` (radius-cli's variable names), and the MPP wire format.
- `radius_sdk.server`: `radius_payments()` for Starlette requests (x402 v2 `exact`, settle before or after the handler, multi-network offers, gas-sponsoring declaration, MPP alongside x402), `RadiusServer` for the upstream x402 FastAPI middleware, `RadiusFacilitatorClient` with unknown outcomes answered 502, and `proxy_to`.
- `radius_sdk.starlette`: `RadiusPaymentsMiddleware` for Starlette and FastAPI apps.
- `radius_sdk.client`: `create_radius_fetch()`, an httpx-based client that pays x402 v2 `exact` (Permit2 or EIP-3009) and `upto`, x402 v1 `exact` and MPP, with the TypeScript client's offer selection, per-request ceiling, approval gate, redirect rules and wallet helpers.
- `radius_sdk.rpc`, `balances`, `erc20`, `permit2`, `settlement`: JSON-RPC client and the chain actions (native vs aggregate balances, ERC-20 reads and writes, chunked Transfer queries and an at-least-once watcher, Permit2 SignatureTransfer and AllowanceTransfer, settlement reconciliation).
- Cross-language tests run against the built TypeScript SDK in both directions.
