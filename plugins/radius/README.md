# Radius plugin

The `radius` Claude Code plugin provides four skills:

- `radius-dev` for Radius Network application development
- `x402` for paying x402 endpoints (agents, terminals, app buyers) and the protocol
- `sell-api` for charging for an API or for articles and pages (including
  charging AI crawlers while readers stay free): framework detection, `radius-sdk`
  seller setup for Hono, Express, Next.js and Astro middleware, and Workers in
  front of an origin, and verification with `radius-cli sell check`
- `dripping-faucet` for testnet faucet workflows

The SDK examples target `radius-sdk` 0.3.0 or later (`sell-api` targets 0.5.0
or later, for MPP and several networks), and terminal wallet examples target
`radius-cli` 0.4.0 or later (`wallet pay`); `radius-cli sell check` needs
`radius-cli` 0.5.0. Install the peer dependencies needed by the SDK entry point
you use: `@x402/core` for every entry point (`radius-sdk` 0.7.0 and later), plus
`@x402/evm` and `viem` for `/client`, and `hono` for `/hono`.

The `evals/` directory holds the Claude Code plugin eval cases. The
`sell-oneshot` case shares its prompt with the repository's deterministic
seller evaluation (`pnpm eval:payments:sell -- --case SELL-ONESHOT`), which
boots the app an agent writes and pays it against a mock facilitator.
The transcript eval runs without an application scaffold, so the shared prompt
provides an assumed manifest when no project is present. The deterministic
runner supplies real Express and Hono projects and checks the written app.
Use decimal USD strings such as `'0.001'` in skill entrypoint examples: Claude
substitutes `$0` and other positional placeholders even inside code fences.
The plugin validator checks for accidental substitutions in those entrypoints.

Install it from the [Radius `tools` repository](https://github.com/radiustechsystems/tools),
the canonical source for current Radius skills. The former `skills` and
`radius-dev-skill` repository names are retired install sources.

```sh
claude plugin marketplace add radiustechsystems/tools
claude plugin install radius@tools
```

The plugin is `radius`, and the marketplace is `tools`. Plugin 0.2.0 replaces
the older `radius-dev@radius-cli` install identity. Follow the
[one-time migration commands](../../packages/docs/docs/pages/build/coding-assistants.mdx#claude-code)
if it is already installed. Individual skill names stay the same; Claude's
plugin prefix becomes `radius`, for example `/radius:sell-api`.

For Codex, run this in your application directory:

```sh
npx skills add radiustechsystems/tools --agent codex \
  --skill radius-dev dripping-faucet x402 sell-api --copy
npx skills list --agent codex
```

The installer copies each skill's `SKILL.md`, references and scripts into the
project's `.agents/skills`. Start a new Codex conversation after installing.
The [public flat skill files](https://docs.radiustech.xyz/build/coding-assistants#public-flat-files)
are expanded reading references; install the full directories for supporting scripts.

After a new plugin version is published, update an existing installation with
`claude plugin update radius@tools`. Automatic updates depend on the
user's marketplace setting.

The plugin is versioned independently from the `radius-cli` and `radius-sdk`
npm packages. Its version is in `.claude-plugin/plugin.json`; the GitHub
marketplace lists the plugin at `.claude-plugin/marketplace.json` in the
repository root. See the [repository release instructions](https://github.com/radiustechsystems/tools#agent-skills)
for validation and compatibility rules.

This plugin is distributed under the repository's [MIT license](https://github.com/radiustechsystems/tools/blob/main/LICENSE).
