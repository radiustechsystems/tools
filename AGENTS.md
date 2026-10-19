# Agent guide: tools

Read `README.md` for the layout, releases and plugin install. This file holds the rules agents tend to get wrong. The docs package has its own guide in `packages/docs/CLAUDE.md`; read it before touching `packages/docs`.

## Before you finish

From the repository root, run whichever of these apply to what you changed. Everything must pass.

- `pnpm build`, `pnpm typecheck` and `pnpm test` for `packages/sdk` or `packages/cli`
- `pnpm --filter radius-sdk run test:mpp` after changing MPP code in the SDK
- From `packages/sdk-python`: `uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy` and `uv run pytest` after changing the Python SDK, or after changing the TypeScript SDK's wire behavior (x402 or MPP headers, payloads, receipts). The interop tests in `tests/test_interop.py` run the two SDKs against each other and need `pnpm build` first
- From `packages/docs`: `pnpm format:check`, `pnpm lint`, `pnpm typecheck:docs`, `pnpm docs:validate`, `pnpm test:skills`, `pnpm docs:markdown-audit`, `pnpm build`, `pnpm docs:agent-check` and `pnpm docs:sitemap-check`. Build the SDK first
- `python3 scripts/validate_plugin.py --base-ref origin/main`, `claude plugin validate plugins/radius --strict` and `claude plugin validate . --strict` after changing `plugins/` or `.claude-plugin/`
- The `eval-loop` skill (`.claude/skills/eval-loop/`) after changing a skill's behavior, an eval case, or SDK or CLI behavior a skill documents

## Rules

- Every PR that changes `packages/cli` or `packages/sdk` adds a changeset (`pnpm changeset`, or a file in `.changeset/`). Never edit `CHANGELOG.md` or package versions by hand.
- `packages/sdk-python` (the Python port, `radius-sdk` on PyPI) is outside Changesets: a release-worthy change bumps `version` in its `pyproject.toml` and `__version__` in `src/radius_sdk/__init__.py`, and adds an entry to its `CHANGELOG.md`, by hand. Keep it wire-compatible with `packages/sdk`: a behavior change in one SDK comes with the matching change in the other, or an interop test that records the difference.
- Docs pages and skills name the Python SDK only once it is on PyPI, as with npm.
- Document an SDK or CLI change in `packages/docs` in the same PR, and audit the skills under `plugins/radius/skills` that cover it.
- A skill may name a new SDK or CLI API only once that version is on npm. State the minimum package version in the skill.
- Bump `plugins/radius/.claude-plugin/plugin.json` in any PR that changes a skill, the plugin manifest or the plugin README: patch for corrections, minor for new capabilities. The plugin is not part of Changesets.
- In skill examples, write prices as decimal strings such as `'0.001'`. Claude substitutes `$0` and other positional placeholders even inside code fences.
- No eval case, test or example you run may spend from a funded wallet. The funded testnet proof (`pnpm eval:payments:live`) runs only when a person asks for it.
- Never print, log or commit private keys, `RADIUS_*` secrets or API keys.
- Write amounts as amount plus asset, no `$`: `0.001 SBC`. RUSD is the fee asset, SBC the x402 payment asset, USD a price unit.
