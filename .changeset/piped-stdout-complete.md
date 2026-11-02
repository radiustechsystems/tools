---
"radius-cli": patch
---

Fix `wallet pay` and `sell check` truncating their output when stdout is a pipe. A large response body or `--json` envelope piped to another program (for example `radius-cli --json wallet pay get <url> | jq .`) was cut off, because the CLI exited before Node finished writing to the pipe. The commands now set the exit code and let stdout drain; exit codes are unchanged.
