---
"radius-cli": minor
---

New ERC-20 wallet commands on `radius-sdk/client`'s `erc20Actions`, each taking `SBC` (default) or any token address: `wallet approve <spender> <amount> [token]` (`max` for unlimited), `wallet allowance <spender> [token] [--owner]`, `wallet token [token]` (name, symbol, decimals, supply), `wallet transfers [token]` (decoded `Transfer` events over a block range, last 10 000 blocks by default) and `wallet watch [token]` (the same, streamed live until Ctrl-C, one JSON object per line with `--json`). `transfers` and `watch` default to transfers sent or received by the local account; `--from` / `--to` pick one side, `--address` another account, `--all` every transfer of the token.
