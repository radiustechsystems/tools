# Radius plugin changelog

The `radius` Claude Code plugin and its skills (`radius-dev`, `x402`, `sell-api`, `dripping-faucet`).
The version is `plugins/radius/.claude-plugin/plugin.json`. Every version bump adds an entry here,
newest first, as `## <version> (<YYYY-MM-DD>)` with the date it reached `main`. The docs release
notes (docs.radiustech.xyz/release-notes) are built from this file: write each change's first
sentence for developers who use the skills.

## 0.2.2 (2026-10-26)

- The buyer install commands in the `x402` and `radius-dev` skills install both x402 peer packages, `@x402/core` and `@x402/evm`. `@x402/evm` is an optional peer that npm and pnpm skip, which left `radius-sdk/client` unable to load. The `sell-api` skill names `@x402/core` for sellers, and the plugin README says which peer each entry point needs.

## 0.2.1 (2026-10-21)

- The `sell-api` skill says Radius SBC offers use EIP-3009, not Permit2, and that MPP support is the `evm` charge method only.

## 0.2.0 (2026-10-16)

- **Breaking:** the plugin is now `radius` in the `tools` marketplace. Install it with `claude plugin marketplace add radiustechsystems/tools` and `claude plugin install radius@tools`. It replaces `radius-dev@radius-cli`; an existing install needs a one-time migration ([commands](https://docs.radiustech.xyz/build/coding-assistants#claude-code)). Skill names are unchanged, and slash commands take the `radius` prefix, for example `/radius:sell-api`.
- The plugin README shows how to install the skills in Codex with `npx skills add`.

## 0.1.2 (2026-10-15)

- The `sell-api` proxy snippet drops `Content-Encoding` and `Content-Length` when Node's `fetch` has already decoded a compressed origin response, and passes the request's `signal` so a client disconnect aborts the origin request.

## 0.1.1 (2026-10-15)

- The `sell-api` skill covers a Hono proxy on Node in front of an origin (with a Dockerfile), checks that free routes stay free, and ends with a minimum verify checklist. Its gotchas add the `duplex` option a stream body needs on Node, and the immutable-headers error a raw `fetch()` response hit after settlement under `@hono/node-server`.

## 0.1.0 (2026-10-15)

- New `sell-api` skill: charge for an API with `radius-sdk`. It detects the framework, installs and configures the SDK, runs the server locally, verifies the `402` with `radius-cli sell check`, and hands off deployment, with references for frameworks, protocols, networks and facilitators, and settlement.
- The `x402` skill covers buying and the protocol, and points sellers to `sell-api`.

## 0.0.6 (2026-10-14)

- Links and install commands point at the renamed repository, github.com/radiustechsystems/tools.

## 0.0.5 (2026-10-13)

- The `radius-dev` skill requires Node.js 22 or later for `radius-sdk`.

## 0.0.4 (2026-10-13)

- The skills use `radius-cli wallet pay` and `--threshold`, the new names for `wallet x402` and `--x402-threshold` in radius-cli 0.4.0.

## 0.0.3 (2026-10-07)

- The `radius-dev` and `x402` skills build with `radius-sdk` (`radius-sdk/client` for buyers, `radius-sdk/hono` for sellers) and `radius-cli`, with viem for other EVM work, instead of hand-written viem payment code.

## 0.0.2 (2026-10-02)

- The `radius-dev`, `x402` and `dripping-faucet` skills move into this repository as the `radius-dev` Claude Code plugin, with eval cases that run in CI.
