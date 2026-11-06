---
"radius-sdk": minor
"radius-cli": minor
---

Sign payments through a wallet proxy, so the process that pays holds no private key. `radius-sdk/signers/proxy` adds `proxySigner({ url, alias, token })`, a `signer` for `createRadiusFetch` backed by the wallet-proxy Worker (`radius-workshop/wallet-proxy`, which keeps Privy, Coinbase CDP or Para credentials in Worker secrets and signs on request), and `proxySignerEnv()` to read its settings from the environment; a proxy that cannot sign throws `RadiusPaymentError` with the new code `signer_unavailable`. In `radius-cli`, `RADIUS_WALLET=proxy` with `RADIUS_WALLET_PROXY_URL`, `RADIUS_WALLET_ALIAS` and an optional `RADIUS_WALLET_PROXY_TOKEN` (or Cloudflare Access `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`) makes every account-needing command sign through the proxy; `wallet pay` asks it to sign only after an offer is accepted, and `wallet new`, `wallet import`, `wallet password` and `wallet export` refuse because the proxy does not export or replace its key.
