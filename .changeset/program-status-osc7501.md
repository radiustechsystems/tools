---
"radius-cli": minor
---

Report prompts and waits to the terminal with the Program Status Protocol (OSC 7501), so a terminal that supports it can show that a tab in the background is waiting on you. A keystore password, payment, Permit2 approval or export prompt reports `blocked`; paying, sending and faucet drips report `working` and end with `done` or `error`; declining or cancelling a prompt reports `idle`. Reports go to stderr only when it is a terminal, so `--json`, pipes and CI logs are unchanged. Set `RADIUS_NO_PROGRAM_STATUS=1` to turn them off.
