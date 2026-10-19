---
"radius-cli": minor
---

Report waiting and progress to the terminal with the Program Status Protocol (OSC 7501). While a keystore password, payment or Permit2 approval prompt is open, `radius-cli` reports `blocked`; while it waits on a transaction or settlement it reports `working`; a run that reported anything ends with `done` or `error`. Terminals that support the protocol can show that a tab in the background is waiting on you. Reports go to stderr only when it is a terminal, so `--json`, pipes and CI logs are unchanged. Set `RADIUS_NO_PROGRAM_STATUS=1` to turn them off.
