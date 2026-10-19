# radius

Tools and developer docs for the [Radius Network](https://radiustech.xyz), managed as one pnpm workspace.

| Package | What |
| --- | --- |
| [`packages/cli`](./packages/cli) | [`radius-cli`](https://www.npmjs.com/package/radius-cli) — CLI wallet for Radius, modeled on Foundry's `cast`; `wallet pay` pays x402 on Radius (and optionally Base) through `radius-sdk`, and `sell check` checks a seller's 402 |
| [`packages/sdk`](./packages/sdk) | [`radius-sdk`](https://www.npmjs.com/package/radius-sdk) — accept and make x402 v2 payments on Radius (and optionally Base or any EVM chain) from any web-standard runtime, Hono, or the upstream x402 framework adapters (Express, Next.js), plus balance and settlement helpers |
| [`packages/sdk-python`](./packages/sdk-python) | `radius-sdk` for Python: the same payments from ASGI sellers (Starlette, FastAPI) and an httpx buyer, wire-compatible with the TypeScript SDK and tested against it; not yet on PyPI |
| [`packages/docs`](./packages/docs) | Source of [docs.radiustech.xyz](https://docs.radiustech.xyz) (Vocs on a Cloudflare Worker); private, never published to npm |

```bash
npx radius-cli wallet balance     # the CLI
pnpm add radius-sdk               # SDK, seller side (add hono, or @x402/express + express, for those stacks)
pnpm add radius-sdk viem          # SDK, buyer / agent side
```

Runnable SDK examples (seller workers with and without Hono, an Express seller, agent buyer, browser demo dapp) are in [`packages/sdk/examples`](./packages/sdk/examples).

The [agent payment evaluation framework](docs/agent-payments-evaluation-framework.md) defines adversarial CLI, SDK, agent, and network scenarios with separate payment, delivery, and reconciliation evidence.

Run its local, unfunded evaluation with `pnpm eval:payments`, its agent decision scenarios with `pnpm eval:payments:agent`, and the seller side, including a one-shot coding-agent integration, with `pnpm eval:payments:sell`. See the [runner guide](evaluations/agent-payments/README.md) for case selection, an external agent adapter, reports, and the opt-in testnet proof.

## Agent skills

The [Radius Claude Code plugin](plugins/radius) contains the `radius-dev`, `x402`
(paying), `sell-api` (charging for an API or for articles and pages), and `dripping-faucet` skills. The marketplace manifest is at
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json). These files
live outside `packages/*`. The plugin has its own version in
[`plugins/radius/.claude-plugin/plugin.json`](plugins/radius/.claude-plugin/plugin.json)
and does not enter the npm Changesets release flow. The marketplace's
`metadata.version` describes the catalog, not the plugin; the marketplace entry
does not duplicate the plugin version.

`radiustechsystems/tools` is the canonical source for all Radius skills and new
installs. The legacy `skills` repository (also reached through `radius-dev-skill`)
is retired; use this repository for updates.

In Claude Code, install from this repository:

```text
/plugin marketplace add radiustechsystems/tools
/plugin install radius@tools
```

The plugin is `radius`, and the marketplace is `tools`. Existing installations
of `radius-dev@radius-cli` need a one-time migration; see the
[migration commands](packages/docs/docs/pages/build/coding-assistants.mdx#claude-code).

For Codex, run this in your application directory:

```sh
npx skills add radiustechsystems/tools --agent codex \
  --skill radius-dev dripping-faucet x402 sell-api --copy
npx skills list --agent codex
```

This installs the skill directories and supporting files under `.agents/skills`
in the application. Start a new Codex conversation after installation.

Update an installed plugin with `claude plugin update radius@tools`.
For every release-worthy change under `plugins/radius/skills`, or to the plugin
manifest or README, bump the plugin manifest version in the same PR: patch for
corrections, minor for new capabilities, major for incompatible stable releases
(next minor while the plugin is 0.x). The
plugin CI check enforces a version increase independently of Changesets.
After merging to `main`, users of this GitHub marketplace can update; marketplace
automatic updates are off by default unless users enable them. A plugin release
may be tagged `radius--v<version>` for a traceable release point.

When CLI or SDK work changes a documented API, audit the affected skills in
the package PR. Publish plugin instructions for a new package API only after
the corresponding npm version is available, and state the minimum package
version in that guidance. This avoids directing installed plugin users to code
that has merged but has not yet been published to npm.

For skill changes, run `python3 scripts/validate_plugin.py`,
`claude plugin validate plugins/radius --strict`, and
`claude plugin validate . --strict`. The path-filtered
[`plugin-evals.yml`](.github/workflows/plugin-evals.yml) runs Claude Code plugin
evals on trusted plugin changes. Add or update cases under
[`plugins/radius/evals`](plugins/radius/evals) with each behavior change, inspect
the CI report, then revise the skill or case based on the observed result.
The existing skill `evaluations/*.json` files remain as scenario references;
Claude Code uses the `evals/` suite for executable checks.

CI accepts either an `ANTHROPIC_API_KEY` secret, or an `OPENROUTER_API_KEY`
secret with repository variable `CLAUDE_EVAL_PROVIDER=openrouter`. Set
`CLAUDE_EVAL_MODEL` and `CLAUDE_EVAL_JUDGE_MODEL` repository variables to model
IDs supported by the chosen provider. The defaults target Anthropic. Fork PRs
run static checks without model credentials; trusted PRs and main pushes run
the paid eval suite. No eval case is allowed to execute wallet or payment tools.

The legacy repository's Hermes subscriber publisher is retired with that
repository. Existing subscriber configuration and historical skill files stay
there for reference. Migrating subscribers to receive updates from `tools`
requires a separate change to their repository and commit settings.

## Development

```bash
pnpm install                          # installs every workspace package
pnpm build                            # builds every package
pnpm test                             # runs every package's tests
pnpm --filter radius-cli build        # one package
node packages/cli/dist/index.js --help
```

The Python SDK in `packages/sdk-python` is not a pnpm package; it has its own toolchain ([uv](https://docs.astral.sh/uv/)), checks and CI workflow (`.github/workflows/python-sdk.yml`), described in [its README](packages/sdk-python/README.md#development).

Requires Node ≥ 22 and pnpm 10 (`corepack enable pnpm`); `.node-version` pins Node 24 for local development, and the docs need Node ≥ 22.15. `pnpm build` / `pnpm test` / `pnpm typecheck` at the root run the npm packages in dependency order; the docs have their own commands and CI ([`packages/docs/README.md`](packages/docs/README.md)). Building or typechecking the CLI on its own also works from a fresh clone: `packages/cli` is a TypeScript project reference to `packages/sdk`, so `tsc -b` rebuilds the SDK whenever its source is newer than its `dist`; the CLI's tests read the SDK from source.

Every PR that changes `packages/cli` or `packages/sdk` adds a [changeset](.changeset/README.md) (`pnpm changeset`); the `changeset` GitHub check enforces it, and a bot comment on the PR lists what will be released. CI (`.github/workflows/ci.yml`) builds, typechecks and tests every package on Node 22 and 24.

## Releasing

Releases are automated with [changesets/action](https://github.com/changesets/action) (`.github/workflows/release.yml`):

1. Merging PRs that carry changesets to `main` opens or refreshes a **Version Packages** PR (branch `changeset-release/main`). It applies the pending changesets: version bumps and `CHANGELOG.md` entries, with `radius-cli` given at least a patch bump whenever `radius-sdk` moves (`updateInternalDependencies: "patch"`), so every SDK release ships a CLI built against it. Review it like any other PR; it keeps updating as more changesets land.
2. Merging the Version Packages PR builds, tests and packs the bumped packages, publishes them to npm in dependency order (SDK before CLI), pushes a `<name>@<version>` git tag for each, and creates a GitHub Release from the changelog.
3. After the publish, the docs deploy to production (`.github/workflows/docs-deploy.yml`), so docs written alongside a change go live with it. Docs-only releases run that workflow by hand; it refuses while package changesets are pending. See [`packages/docs/README.md`](packages/docs/README.md#hosting-and-releases).

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers): the `publish` job authenticates with a short-lived GitHub OIDC token, no `NPM_TOKEN` secret exists, and npm attaches provenance attestations automatically. Only that job has `id-token: write`.

One-time setup (repeat the npm step for every new package):

- On npmjs.com, for `radius-cli` and `radius-sdk`: **Settings → Trusted Publisher → GitHub Actions**, organization `radiustechsystems`, repository `tools`, workflow filename `release.yml`, environment blank (or `npm` if you enable the `environment:` line in the publish job). Allow direct `npm publish` for this workflow. Once a trusted publish succeeds, set **Publishing access** to *Require two-factor authentication and disallow tokens* so tokens can no longer publish. Both packages must declare `repository.url` as `git+https://github.com/radiustechsystems/tools.git`, with their respective `repository.directory` values.
- On GitHub, **Settings → Actions → General → Workflow permissions**: tick *Allow GitHub Actions to create and approve pull requests* (needed to open the Version Packages PR) and choose *Read repository contents and packages permissions* (every workflow declares the permissions it needs). If the option is greyed out, enable it for the organization first.
- For the docs: Actions secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts edit, for the account that owns `docs.radiustech.xyz`) and `CLOUDFLARE_ACCOUNT_ID`. The `docs-production` environment is created on first deploy; add required reviewers there to gate docs deploys.
- Optional: mark the `changeset`, `Node 22` and `Node 24` checks as required in the `main` branch ruleset.

If a publish fails, fix the cause and re-run the failed jobs in the existing
Release workflow. Keep publishing in GitHub Actions through OIDC; do not work
around a repository mismatch with a local publish or an npm token. If publishing
succeeded and only docs deployment failed, use the Deploy docs workflow on a
ref with no pending package changesets. A subsequent Release run with no new
packages skips publishing and the dependent docs deployment.

`pnpm pack`/tarball publishing in CI does not run `prepublishOnly`, which is why
the release workflow builds and tests explicitly and relies on Changesets'
dependency ordering.
