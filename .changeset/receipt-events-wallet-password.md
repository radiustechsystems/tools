---
"radius-cli": minor
---

Add `receipt --event <sig>` to decode a receipt's logs against cast-style event signatures (repeatable; `--json` emits an array of decoded or raw logs), and `wallet password` to add or change the keystore password without changing the key or address (`RADIUS_NEW_PASSWORD` skips the prompt). The auto-created keystore notice now points to `wallet password` instead of `wallet new --force`, which replaced the key. Keystores are now written to a temporary file and renamed into place. **Breaking for scripts that parse human output:** `wallet balance` without `--json` now prints `SBC:`, `RUSD:` and `Total:` on separate lines instead of one `Balance:` line; the `--json` output is unchanged.
