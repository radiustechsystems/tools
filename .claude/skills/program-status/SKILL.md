---
name: program-status
description: Keep radius-cli's OSC 7501 program status reporting correct. Use after adding or changing a prompt, a network wait or a command in packages/cli, after editing packages/cli/src/lib/programStatus.ts, or when a program-status test fails.
---

# Program status (OSC 7501)

radius-cli tells the terminal when it is waiting on the user or the network (spec: https://www.superlogical.com/rex/docs/build/program-status, revision 0.4 of 2026-10-10). The rules for how are in the header of `packages/cli/src/lib/programStatus.ts`. Read it before changing anything here.

## Check

From the repository root:

```sh
pnpm --filter radius-cli build
pnpm --filter radius-cli exec vitest run tests/program-status
```

Build first: the terminal tests run `dist/`. In CI a missing `dist/` fails the run.

## What the tests hold you to

- `tests/helpers/osc7501.ts` checks captured bytes against the protocol: states, `kind` only on `blocked`, base64 `msg` under 2048 bytes with no control characters, `blocked` always followed by another report, nothing after a cancel, and a run that waited on the network ending in `done`, `error` or `idle`.
- `tests/program-status-conformance.test.ts` drives the reporter through each scenario, runs `wallet new` on a real pseudo-terminal (needs `python3`, reaches no network and no funds), and checks that `--json`, a pipe, `CI`, `TERM=dumb` and `RADIUS_NO_PROGRAM_STATUS` send nothing.
- The same file scans `packages/cli/src` and fails when a prompt is not wrapped or a network wait never reports.

## Fix a failure

- **A new prompt:** wrap it. `programStatus.whileBlocked('auth' | 'permission' | 'question', 'Short message', () => prompt(...))`.
- **A new network wait:** call `programStatus.working('Doing X')` before it and `programStatus.succeeded('Did X')` once it works. Messages are fixed templates filled with validated values (`shortHex` for hashes), never server text, secrets or private keys.
- **A real exception:** add an entry with a reason to `NETWORK_ALLOWLIST` or `RUNREQUEST_ALLOWLIST` in the conformance test. A stale entry fails too, so remove it when the code changes.
- **Do not edit the checker to make a failure go away** unless the CLI deliberately changed what it reports. Say why in the PR.

## Spec drift

CI never fetches the spec. At each `radius-cli` minor release, re-read it, compare it with `tests/helpers/osc7501.ts` and `programStatus.ts`, and update the revision and date in the header of the helper.

## Not covered

A terminal that ignores OSC 7501 shows nothing, so nothing in these tests shows the indicator itself. Ctrl-C or a signal during a network wait can skip the exit hook and leave the terminal on `working`. Neither is tested yet.
