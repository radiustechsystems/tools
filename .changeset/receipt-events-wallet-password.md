---
"radius-cli": minor
---

Add `receipt --event <sig>` to decode a receipt's logs against cast-style event signatures (repeatable; `--json` emits an array of decoded or raw logs), and `wallet password` to add or change the keystore password without changing the key or address (`RADIUS_NEW_PASSWORD`, at least 8 characters, skips the prompt; `--remove` removes the password). `receipt --event` exits 1 when the transaction reverted. The auto-created keystore notice now points to `wallet password` instead of `wallet new --force`, which replaced the key. Keystores are now written to a unique, fsynced temporary file and renamed into place, through a symlinked keystore path to its target. **Breaking for scripts that parse human output:** `wallet balance` without `--json` now prints `SBC:`, `RUSD:` and `Total:` on separate lines (e.g. `SBC:     0.030002 SBC`) instead of one `Balance:` line; the `--json` output is unchanged.
