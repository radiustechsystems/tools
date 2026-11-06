---
"radius-cli": minor
---

`sell check` scores every run from 0 to 100 (each blocking failure costs 40, any other failure 15, a warning 5) and prints the points each check cost; `--json` adds `score` and a per-check `deduction`. `--min-score <n>` makes the score set the exit code. `--ci` prints plain, stable output, never prompts or pays, and on GitHub Actions emits `::error` / `::warning` annotations and a job summary. Two new checks: a malformed payment credential (`PAYMENT-SIGNATURE`, `X-PAYMENT`, `Authorization: Payment`) must get a 402, not a 5xx or the paid content; and when the seller publishes an OpenAPI document (`/openapi.json`, or `--openapi <url|file>`; `--no-openapi` skips it), the route must be listed as paid the way the Radius Platform reads it: an `x-radius-price` that matches the 402, or a documented `402` response, and no `x-radius-free`. An `x-payment-info` object is compared when present but never required.
