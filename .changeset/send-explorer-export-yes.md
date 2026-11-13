---
'radius-cli': minor
---

Add the explorer link to `wallet send` output, and `--yes` to `wallet export`. `wallet send` prints an `Explorer:` line after the receipt, and its `--json` output adds `explorerUrl` (`{hash, receipt, explorerUrl}`, or `{hash, explorerUrl}` with `--no-wait`). With `--no-wait`, the text output stays the bare hash on stdout and the link goes to stderr, so `hash=$(radius-cli wallet send … --no-wait)` keeps working. `wallet export --yes` (`-y`) prints the private key without the confirmation prompt, so agents and boot scripts can run it unattended; the prompt stays the default. Without `--yes`, a prompt closed by end of input now fails with a hint to pass `--yes` instead of "User force closed the prompt".
