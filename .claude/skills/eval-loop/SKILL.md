---
name: eval-loop
description: Run the Radius plugin evals and the agent payment evals, read the failures, fix the skill or the code, and re-run until they pass. Use after changing a skill under plugins/radius, an eval case, or SDK or CLI behavior a skill documents, or when asked to improve a skill from eval results.
---

# Eval loop

Two suites. Run the one that covers your change, or both.

## Plugin evals (skill behavior)

Cases live in `plugins/radius/evals/<case>/`: `prompt.md` (frontmatter sets `max_turns` and `allowed_tools`) and `graders/*.md`. Add or update a case with every behavior change.

1. From `plugins/radius`, run the cases you touched with CI's settings:

   ```sh
   claude plugin eval . --trust-plugin --case '<case>' --runs 2 --ablation none \
     --threshold 0.75 --no-publish --json results.json --max-cost-usd 2
   ```

   Drop `--case` to run the whole suite. The run uses this session's credential.

2. List what failed:

   ```sh
   jq -r '.cases[] | .name as $c | .arms.with[] | .graders[] | select(.passed | not)
     | "\($c) \(.name): \(.explanation)"' results.json
   ```

   Each run's `tracePath` holds the full transcript; read it to see what the agent did.

3. Fix the skill (`plugins/radius/skills/<skill>/SKILL.md` or its `references/`). Change a grader only when it is wrong about the correct behavior, and say why in the PR.
4. Re-run the same cases. Stop when every case scores at least 0.75. If the same case fails three rounds in a row, stop and report what you tried.
5. Run `python3 scripts/validate_plugin.py --base-ref origin/main` and bump the plugin version (`AGENTS.md`).

`results.json` and `evals/results/` are gitignored. Don't commit them.

## Agent payment evals (SDK, CLI and seller behavior)

Deterministic and unfunded. From the repository root:

```sh
pnpm build
node evaluations/agent-payments/run.mjs     # CLI and SDK buyer cases
node evaluations/agent-payments/agent.mjs   # agent decision cases
node evaluations/agent-payments/sell.mjs --skip-provisioned   # seller cases
```

Add `--case <ID>` to run one case and `--list` to see them. Reports go to `evaluations/agent-payments/results/`. Any `FAIL` exits nonzero. An `XFAIL` that starts passing also fails: remove its marker in `sell.mjs` and the known gap in `evaluations/agent-payments/README.md`.

To grade the `sell-api` skill end to end, have a real agent write the seller app:

```sh
SELL_INTEGRATOR_CMD='claude -p "$(cat "$SELL_PROMPT_FILE")" --plugin-dir "$SELL_REPO_ROOT/plugins/radius" --allowedTools "Skill,Read,Glob,Grep,Write,Edit" --permission-mode dontAsk' \
  node evaluations/agent-payments/sell.mjs --case SELL-ONESHOT
```

A failure there is a gap in the `sell-api` skill unless the reference fixture in `evaluations/agent-payments/fixtures/sell-oneshot/` fails too.

Never run `pnpm eval:payments:live` unless a person asks for it: it spends testnet funds.
