# Run the agent payment evaluation

From the repository root, after `pnpm install --frozen-lockfile`:

```sh
pnpm eval:payments          # build, then run 20 local HTTP/CLI/SDK/policy cases
pnpm eval:payments:agent    # build, then run 6 proposal cases x 3 seeds x 2 phrasings
pnpm eval:payments:sell     # build, then run 12 seller cases against the real SDK seller
```

All three commands are unfunded and require no RPC or wallet credentials. On first use the seller suite also installs Next.js and Astro from the npm registry into a cache directory, and skips those cases when it cannot ([Provisioned frameworks](#provisioned-frameworks)). The seller suite is described [below](#seller-evaluation). The first starts loopback HTTP seller, redirect sink, and JSON-RPC fixtures; it runs the built CLI as a subprocess and the SDK buyer directly. It checks signed EIP-3009 and Permit2 authorizations, offer selection, threshold refusal, POST body replay, redirect handling, missing receipts, paid errors, and lost responses. A small file-backed policy fixture also checks concurrent budget reservation and restart/idempotency behavior. These checks do not constitute a production policy service. The fixture simulates settlement. `simulatedSettlement: true` never means a network payment occurred.

The second command tests **agent proposals** and host authorization. Its default adapter is [`reference-agent.mjs`](reference-agent.mjs), a deterministic policy baseline, not a language model. It receives task wording, page text, a parsed 402 offer, and policy as JSON on stdin; it returns one JSON object such as `{"decision":"buy","selectedUrl":"https://seller.eval.local/api/lookup"}` on stdout. Valid decisions are `buy`, `decline`, and `reconcile`; `selectedUrl` is required only for `buy` and must be the offered URL. An adapter that exits without reading its input fails that case. The host keeps the signer and refuses a wrong recipient, over-cap offer, exhausted budget, or unknown prior outcome. The adapter does not browse live pages, and `reconcile` is a proposal only. This run does not prove full autonomous discovery, durable budget enforcement, or network settlement.

The file-backed policy fixture is an evaluation oracle, not a deployable policy service. It serializes concurrent reservations and preserves an unknown/settled task across reopening the ledger, rejects a changed offer under one idempotency key, and blocks invalid state transitions. Its `simulatedVerified` marker is supplied by the test and does not check chain evidence. A killed-process recovery drill is not covered; abandoned lock directories are not recovered by this fixture.

Useful options after the build:

```sh
node evaluations/agent-payments/run.mjs --list
node evaluations/agent-payments/run.mjs --case SDK-UPTO
node evaluations/agent-payments/agent.mjs --case DISC-02 --seed 2
node evaluations/agent-payments/agent.mjs --agent-command node \
  --agent-arg /absolute/path/to/your-agent-adapter.mjs
```

An external adapter is a trusted local executable invoked without a shell. It receives no Radius signer environment variables. Only `PATH` is passed by default; use `--agent-env NAME` to pass a specific non-`RADIUS_` variable such as a model API key. Each invocation has a 30-second timeout and a 64 KB output limit. A malformed or failing adapter creates failed case records and a nonzero suite exit. Your adapter can use any model or agent framework as long as it follows the JSON stdin/stdout protocol. The input includes `scenarioId`, `seed`, `task`, `page`, `url`, `offer`, `policy`, and `previousOutcome`.

Reports are written to the ignored `evaluations/agent-payments/results/` directory. Use `--output /path/report.json` to choose another location. Reports include case failures, per-axis scores, package commit, redacted HTTP traces, and explicit `verifiedNetworkSettlement: false` for local runs. The offline runner exits nonzero on any failed case.

## Seller evaluation

`pnpm eval:payments:sell` ([`sell.mjs`](sell.mjs)) grades the **seller** side. Every case runs the real `radius-sdk` seller over loopback HTTP, across three adapters where they apply: `radiusPayments()` (web-standard), the `radius-sdk/hono` middleware, and `createRadiusServer` behind the upstream `@x402/express` adapter. The real SDK buyer (and, in SELL-ONESHOT, the built CLI) pays it. `@x402/next` is not installed in this workspace and is not covered; the publisher cases below run `radiusPayments()` inside real Next.js and Astro middleware and a Cloudflare Worker instead.

The facilitators are local mocks ([`mock-facilitator.mjs`](mock-facilitator.mjs)) that implement `/supported`, `/verify` and `/settle`. They check what a facilitator checks before moving funds: the payment matches the requirements, the authorization is within its validity window, and its EIP-712 signature (EIP-3009 or Permit2, via [`signatures.mjs`](signatures.mjs), shared with `run.mjs`) recovers to the payer. They also record consumed nonces, so a second settlement of one authorization fails as it would on chain. A case can make a facilitator reject, hang, or drop the connection after recording the settlement. Settlement is simulated, and the report says `verifiedNetworkSettlement: false`.

| ID | What it checks |
| --- | --- |
| SELL-ONESHOT | Scaffolds a fresh TypeScript Express app and a fresh Hono app, has an integrator write `server.ts`, boots it with `node --experimental-strip-types`, and grades it with checks for the free route, the 402 offer (amount, asset, network, `PAY_TO`), an SDK buyer happy path settled once, a CLI over-threshold refusal, a payment re-signed to a man-in-the-middle recipient (refused), a replayed payment (refused), and `radius-cli sell check --price '$0.001'` against the mock facilitator (exit 0, nothing paid). |
| SELL-CHALLENGE | 402 correctness per adapter: amount and decimals (including an 18-decimal asset), `payTo`, asset, network, transfer method, `resource` bound to the requested URL, `maxTimeoutSeconds`, `no-store`, and no handler run. The MPP `WWW-Authenticate: Payment` challenge mirrors the offer on `radiusPayments`/Hono. The test asserts that `@x402/express` emits no MPP challenge (a known gap; upstream adapters are x402 only). |
| SELL-DUAL | One route offering both x402 and MPP: each protocol settles exactly once. An MPP credential with a tampered challenge amount or expiry, an expired challenge, or a challenge issued under a different `secretKey` is refused. The untampered credential still pays at its issuer. |
| SELL-MULTI-NET | One route offering Radius testnet (72344) and Base Sepolia (84532): each payment settles only through its network's facilitator. A payload signed for one offer and relabeled as the other is refused. |
| SELL-FACILITATOR | `/supported` order (EIP-3009 first gives an EIP-3009 offer with MPP and no gas-sponsoring declaration; Permit2 first gives a Permit2 offer without MPP, declaring sponsoring only when the facilitator lists it), a custom in-process `FacilitatorClient`, and, for settle `before` and `after`: explicit rejection (402, `payment_rejected`), timeout (502), and connection dropped after settlement (502, the mock ledger shows funds moved). Content is withheld in each case, and the buyer can tell rejection from unknown outcome. |
| SELL-REPLAY | The same payment header sent twice, sequentially and concurrently, in both settle modes (plus an MPP credential replay), is served once and settled once. Concurrent replays in `after` mode run the handler twice; the losing response is withheld, and the handler run counts are recorded. |
| SELL-ORDER | Paid 200, 404, 500 and a throwing handler, in each settle mode. `after` settles only on status < 400. In `before` mode, the case asserts that every failure settled and carries the receipt (settled plus delivery failed). |
| SELL-ROUTING | Dynamic `payTo` per creator and dynamic price from the query (duplicate keys included), overlapping routes, path spellings (case, percent-encoding, double and trailing slashes, dot segments), and a paid response marked cacheable. It checks that the challenge binds the intended route and recipient, nothing protected is served free, and a payment for one resource cannot unlock another. |

The four publisher cases run the real seller inside a real framework or runtime, with fixtures under [`fixtures/`](fixtures/) that mirror the examples in the `sell-api` skill's `frameworks.md` and `publishers.md`. They use the same mock facilitator and real SDK buyer.

| ID | What it checks |
| --- | --- |
| SELL-NEXT-MW | Next.js 15.5.27 middleware in the edge runtime (`next build`, `next start`), gating an ISR page (`generateStaticParams`), a fully static page, a `force-dynamic` page, a Pages Router `getStaticProps` page, and its `/_next/data/<buildId>/…json` URL. Unpaid: `402`, `no-store`, no content, x402 offer plus MPP challenge; RSC and `HEAD` requests are priced; a browser User-Agent reads free. Paid: x402 and MPP settle once with a receipt and a `private` response, and a paid request does not poison the ISR cache. Validating slugs before `pay` turns a missing page into a free 404; rebuilding the request from `x-forwarded-host` puts the public URL in `resource.url`. `radius-cli sell check` passes. |
| SELL-ASTRO-MW | Astro 4.15.12 and 5.18.1 SSR middleware on `@astrojs/node`, built with `astro build`. A guarded middleware (`context.isPrerendered` on Astro 5, a `Host` check on Astro 4) leaves the prerendered page intact (PASS); an unguarded one has its 402 written into the static page at build time (XFAIL); a server-rendered page settles over x402 and MPP, is `no-store` unpaid and `private` paid; a prerendered page named in the routes is served free (XFAIL); Astro 5 needs `security.allowedDomains` for `resource.url` to name the forwarded host (XFAIL without it, PASS with it). |
| SELL-WORKER-PROXY | `radiusPayments()` in a Cloudflare Worker (workerd through the workspace's `wrangler dev`) in front of a local origin that sends `Cache-Control: public, s-maxage`, `CDN-Cache-Control`, `Surrogate-Control`, `Surrogate-Key` and `Set-Cookie`. A path outside the routes goes to the origin free; unpaid requests get a `402` and never reach the origin; x402 and MPP payments return the origin's body; the payment credential is not forwarded; the paid response is `private`. The origin's CDN headers pass through (XFAIL), and a wrapper that strips them produces `private, no-store` (PASS). With `settle: 'before'` a paid origin 404 settles (XFAIL); with `settle: 'after'` it does not. |
| SELL-SELECTIVE | Humans free, agents pay, with the wrapper in [`fixtures/sell-selective/gate.mjs`](fixtures/sell-selective/gate.mjs). A browser User-Agent gets the page free and the facilitator is never called; vendor crawler UAs, a script UA and a `Signature-Agent` header get a `402`; a bot pays over x402 and MPP; a payment header from a browser-looking client is still settled. A browser User-Agent sent by an agent is served free: recorded as a documented limitation, not a failure. A valid subscriber cookie bypasses the gate and a forged one does not. `radius-cli sell check -H 'User-Agent: …'` passes for a bot UA and fails for a browser UA. |

### Provisioned frameworks

Next.js and Astro are not workspace dependencies. `SELL-NEXT-MW` and `SELL-ASTRO-MW` install them on first use with `npm install --ignore-scripts` into a cache directory (`$SELL_EVAL_CACHE`, default `<tmpdir>/radius-sell-eval-cache`, about 340 MB for Next 15 and 150 MB for each Astro) and reuse them afterwards; each run builds a scratch copy of the fixture beside them and links this checkout's `packages/sdk` as `radius-sdk`. A first run needs the npm registry and takes about a minute longer. When a framework cannot be installed (offline, no `npm`, or `--skip-provisioned` / `SELL_SKIP_PROVISIONED=1` with an empty cache) the case reports **SKIP**, prints the reason, and does not fail the run; a case where nothing else ran counts as skipped in the summary. A framework that installs but fails to build is a failure. `SELL-WORKER-PROXY` needs only the workspace's `wrangler` (workerd), so it runs offline; it skips when `wrangler` is not installed. Delete the cache directory to force a fresh install. There is no Fastly case: running Compute locally needs Fastly's CLI and Viceroy download, so Fastly was checked by hand only.

A case passes, fails, is skipped, or reports **XFAIL**. XFAIL means a check that states the correct behavior currently fails because of a known SDK or adapter gap. It prints `XFAIL <id>: <check>: <reason>`, is listed under `knownGaps` in `results/sell.json`, and does not fail the run. An XFAIL check that starts passing fails the run, so the marker gets removed. Current known gaps:

- In `after` mode, when settlement fails after the handler ran, the body is withheld but the handler's response headers are not: radius-sdk/hono (Hono's `c.res` setter merges them back) and `@x402/express`.
- On radius-sdk/hono, a handler's `Cache-Control` replaces the SDK's `private` on paid responses, for the same reason.
- An unpaid `HEAD` request to a paid `GET` route runs the paid handler on every adapter, because x402 route verbs match exactly while routers serve HEAD with the GET handler. No body is delivered.
- Next.js middleware: a paid request for a missing page settles and returns `404`, because the middleware settles before Next renders and `NextResponse.next()` is always a `200` to the SDK. `settle: 'after'` does not change that (recorded). `pay(req, …)` with the raw `req.url` reports `localhost` in `resource.url` under `next start` even when `X-Forwarded-Host` is set; rebuilding the request (the fixture's `publicRequest`) passes.
- Astro middleware: prerendered pages are served free by the adapter, and an unguarded middleware writes its 402 into the built page. On Astro 5, `resource.url` ignores `X-Forwarded-Host` unless `security.allowedDomains` names the host.
- Worker in front of an origin: on a paid response the SDK leaves the origin's `Surrogate-Control`, `CDN-Cache-Control` and `Surrogate-Key` in place, and with `settle: 'before'` a paid origin 404 settles.

Not an SDK gap, but recorded by `SELL-SELECTIVE` as a documented limitation: an agent that sends a browser User-Agent is served free by any header-based predicate.

Some behaviors are recorded under `observations` without being graded. x402 core picks the first declared route, so a generic pattern declared before a specific one prices both at the generic price. Payments are matched by offer, not by resource URL. A paid response keeps the handler's `public` directive next to the added `private`. The report also records per-adapter outcomes for SELL-ORDER and SELL-REPLAY.

### One-shot agent hook

By default, SELL-ONESHOT copies the reference integrations in [`fixtures/sell-oneshot/`](fixtures/sell-oneshot/), which are the minimal apps a one-shot agent should produce. To grade a real coding agent instead, set `SELL_INTEGRATOR_CMD`. The command runs through the shell once per framework, inside a fresh app directory. That directory contains a `package.json` that lists `radius-sdk`, `viem` and one framework (`express` with `@x402/express` and `@x402/core`, or `hono`), and a `node_modules` linking exactly those. The command must write `server.ts` there, following the task in `PROMPT.md`.

The task is [`plugins/radius/evals/sell-oneshot/prompt.md`](../../plugins/radius/evals/sell-oneshot/prompt.md) without its frontmatter. The same file is a Claude Code plugin eval case, whose graders check that the `sell-api` skill fired and judge the reply; this runner is its deterministic grader. For the scaffolded apps, the agent must read the framework from the actual `package.json` and find the `sell-api` skill on its own, so load the Radius plugin into the agent. In the plugin runner's empty, read-only workspace, the prompt supplies an assumed Hono manifest and requests complete code in the reply. That fallback does not replace this runner's real framework-specific manifests or executable checks. With Claude Code:

```sh
SELL_INTEGRATOR_CMD='claude -p "$(cat "$SELL_PROMPT_FILE")" --plugin-dir "$SELL_REPO_ROOT/plugins/radius" --allowedTools "Skill,Read,Glob,Grep,Write,Edit" --permission-mode dontAsk' \
  pnpm eval:payments:sell -- --case SELL-ONESHOT
```

`--plugin-dir` loads the plugin for that session only, `--allowedTools` pre-approves the listed tools, and `--permission-mode dontAsk` denies everything else instead of prompting (flags as of Claude Code 2.1). The agent gets no shell, so it cannot install packages, start the app or run `radius-cli`; add `Bash` to let it run `radius-cli sell check` itself, which also lets it run anything else.

The command receives `SELL_FRAMEWORK` (`express` or `hono`), `SELL_APP_DIR`, `SELL_PROMPT_FILE` and `SELL_REPO_ROOT`, plus the caller's environment minus every `RADIUS_*` variable. It is a trusted local command: it runs with your user's permissions, and there is no sandbox. `SELL_INTEGRATOR_TIMEOUT_MS` defaults to 15 minutes. The grader then starts the app with `PORT`, `PAY_TO` and `RADIUS_FACILITATOR_URL` (a mock facilitator), and runs the same checks it runs on the reference. The report records the integrator, its exit status, and the tail of its output.

Useful options: `node evaluations/agent-payments/sell.mjs --list`, `--case SELL-DUAL`, `--skip-provisioned` (use cached frameworks, never install) and `--output /path/report.json`. There is no funded seller variant beyond `NET-01` below, which already pays an in-process `radiusPayments` seller through the real testnet facilitator.

## Funded testnet proof

The opt-in command pays a **0.001 SBC resource price** to a separate seller on Radius testnet; network fees may also apply. It uses an in-process SDK seller and buyer, the real facilitator, and an independent transaction receipt plus payment-asset transfer check. It refuses unsponsored Permit2 approval, so a facilitator without gas sponsorship can make the run fail before payment. Provide a testnet-only key through a secure environment source; the runner never prints it.

```sh
pnpm build
# Set RADIUS_EVAL_PRIVATE_KEY and RADIUS_EVAL_PAY_TO in the environment securely only for the next command.
RADIUS_EVAL_LIVE=1 pnpm eval:payments:live --confirm-testnet-spend
```

The command requires `RADIUS_EVAL_PAY_TO` to differ from the buyer address and cannot select mainnet. A paid failure writes a partial report containing any known transaction hash for reconciliation. A successful `live.json` report is the only runner output with `verifiedNetworkSettlement: true`. On 2026-10-07, `NET-01` passed once with a distinct recipient, delivered HTTP 200, and a matching 1,000-atomic-unit testnet transfer in transaction `0x334e08c9673c4da6760035e1130095039b279bda36a5456983be1cd7e9d7f6d2`.

The broader [framework and scenario catalog](../../docs/agent-payments-evaluation-framework.md) also proposes process-level concurrency, browser discovery, live unknown-outcome recovery, and live seller delivery recovery. Those are not implemented by these commands yet.
