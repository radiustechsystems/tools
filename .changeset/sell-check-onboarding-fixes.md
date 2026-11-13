---
"radius-cli": minor
---

`sell check` recognises a free quota: an unpaid `2xx` with `RateLimit-Remaining` is reported (limit, remaining, reset) and used up with at most `--free-requests` (default 25) more unpaid requests before the 402 is checked, instead of failing as "served without payment". `sell check --pricing <file|url>` checks every route of a Radius Platform pricing.md against its own price (`--base-url`, `--param name=value`), with a report per route and totals. The no-MPP hint no longer names one SDK. New global `--password-file <path>` unlocks the keystore without a prompt; without a terminal and without it or `RADIUS_PASSWORD`, commands fail with a message naming both (`sell check --pay` before making any request) instead of a prompt error.
