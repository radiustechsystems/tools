# radius-sdk

Accept and make [Radius](https://radiustech.xyz) payments over standard [x402 v2](https://x402.org),
and optionally [MPP](https://mpp.dev) (see [Protocols](#protocols-x402-and-mpp)).
Sellers run on any stack that speaks web-standard `Request`/`Response` (Cloudflare Workers, Bun,
Deno, Node, Next.js and SvelteKit route handlers), on Hono, or on Express / Next.js through the
upstream x402 adapters. Radius mainnet and SBC are the defaults; Base (USDC) and any other EVM
chain can be added alongside, see [Networks and currency](#networks-and-currency).

Pre-1.0: minor versions may change the API. Release notes are in [CHANGELOG.md](./CHANGELOG.md).

| Entry point | What | Needs |
| --- | --- | --- |
| `radius-sdk` | networks, amounts, receipts, errors, `radiusEnv` (no viem at runtime) | `@x402/core` |
| `radius-sdk/server` | `radiusPayments()` web-standard seller handler; `createRadiusServer()` for the upstream `@x402/*` adapters; `registerRadius()` for an x402 server you already run | `@x402/core` |
| `radius-sdk/hono` | `radiusPayments()` Hono middleware (wraps `radius-sdk/server`) | `hono` |
| `radius-sdk/client` | `createRadiusFetch()` paying fetch, balance and settlement actions | `viem`, `@x402/core`, `@x402/evm` |

## Install

Install the peer dependencies for the entry point you use. `@x402/core` is a required peer
dependency (the SDK is built on its resource server and client), so you install it yourself and
your app and the SDK share one copy; a second copy of `@x402/core` breaks `instanceof` checks and
x402 types. `@x402/evm` is a peer dependency of the buyer client only.

```sh
# Seller on Workers / Bun / Deno / Node / route handlers
pnpm add radius-sdk @x402/core

# Seller on Hono
pnpm add radius-sdk @x402/core hono

# Seller on Express (or Next.js with @x402/next)
pnpm add radius-sdk @x402/core @x402/express express

# Buyer / agent (including applications that also accept payments)
pnpm add radius-sdk @x402/core @x402/evm viem
```

The supported range is `@x402/core` and `@x402/evm` `^2.27.0`; keep your `@x402/*` packages
(including upstream adapters) on the same version. Hono, viem and `@x402/evm` are optional peer
dependencies. The `radius-sdk/hono` entry point requires Hono; `radius-sdk/client` requires
viem `^2.48.11` and `@x402/evm`. Root, server and Hono entry points do not load
viem at runtime. Network definitions remain compatible with viem's `Chain` type; TypeScript consumers
that resolve those declarations may also need viem installed for its types.

Applications already using a compatible viem version can use that installation for the SDK's
buyer client. The peer range makes this shared dependency explicit; applications using an
older or incompatible version need to update it.

This isolates runtime imports, not the installed dependency tree: `@x402/evm` currently depends
on viem itself, so package managers can still install a transitive copy. Buyer applications
should declare viem directly rather than rely on that copy being accessible. Deduplication
across the full dependency tree depends on compatible ranges and the package manager's resolution.

## Accept payments (seller)

The payment configuration is the same everywhere; only the wrapper changes.

**Any web-standard runtime** (Cloudflare Workers without a framework, Bun, Deno, Node 22+,
Next.js / SvelteKit / Remix route handlers): a handler that takes a `Request` and returns a
`Response`. Paid handlers receive the settled receipt.

```ts
import { radiusPayments } from 'radius-sdk/server';

const pay = radiusPayments({
  network: 'testnet',                 // default 'mainnet'; or 'base', 'base-sepolia', … see below
  payTo: '0xYourWallet',              // or (request) => …
  routes: {
    'GET /api/lookup': { price: '$0.001', description: 'One lookup' },
    'POST /api/query': '$0.01',                 // shorthand
    'GET /api/raw':    { price: { amount: '100' } },   // atomic units (6 decimals for SBC)
  },
});

export default {
  fetch: pay.wrap((request, payment) => Response.json({ ok: true, paidBy: payment?.payer })),
};
// or, with your own router: `pay(request, (request, payment) => router.handle(request))`
```

**Validate, then pay.** With the default `settle: 'before'`, funds move before your handler runs,
so anything the handler discovers afterwards (missing record, failed lookup) is a paid error.
Do fallible work before calling `pay`, return the unpaid 404 there, and hand the prepared result
to the paid handler. `examples/astro-seller` shows this in an Astro API route:

```ts
export const GET: APIRoute = async ({ request, params }) => {
  const article = await loadArticle(params.slug);
  if (!article) return new Response('Not found', { status: 404 });   // nothing charged
  return pay(request, () => Response.json(article));                 // charge, then deliver
};
```

**Hono** (`pnpm add hono`): the same options as middleware; dynamic `payTo`/`price` and
`onSettled` receive the Hono context and paid handlers read `c.get('radiusPayment')`.

```ts
import { Hono } from 'hono';
import { radiusPayments, type RadiusPaymentVariables } from 'radius-sdk/hono';

type Env = { Bindings: { PAY_TO: `0x${string}` }; Variables: RadiusPaymentVariables };
const app = new Hono<Env>();

app.use('/api/*', radiusPayments<Env>({
  network: 'testnet',
  payTo: (c) => c.env.PAY_TO,
  routes: { 'GET /api/lookup': { price: '$0.001', description: 'One lookup' } },
}));

app.get('/api/lookup', (c) => c.json({ ok: true, paidBy: c.get('radiusPayment')?.payer }));
export default app;
```

**In front of an origin you do not change** (any language): `proxyTo(origin)` (from
`radius-sdk/server` or `radius-sdk/hono`) forwards a request with its method, path and query.
Use it as the paid handler (`pay.wrap(proxyTo(origin))`, or `app.all('/*', (c) => toOrigin(c.req.raw))`
after the Hono middleware). It buffers the body, drops `Host`, hop-by-hop headers and payment
credentials (`Authorization: Bearer …` passes through), asks for `Accept-Encoding: identity`
(and drops `Content-Encoding` from a body `fetch` decoded anyway), passes the request's `signal`,
returns redirects unfollowed, and copies the response headers so the receipt can be added.

**Express, Next.js, or any other framework with an upstream x402 adapter**: the SDK provides
the Radius resource server and routes, the adapter provides the middleware.

```ts
import express from 'express';
import { paymentMiddleware } from '@x402/express';       // or `paymentProxy` from '@x402/next'
import { createRadiusServer } from 'radius-sdk/server';

const radius = createRadiusServer({ network: 'testnet' });
const app = express();
app.use(paymentMiddleware(
  radius.routes({ payTo: '0xYourWallet', routes: { 'GET /api/lookup': '$0.001' } }),
  radius.server,
));
app.get('/api/lookup', (_req, res) => res.json({ ok: true }));
```

`radius.routes()` accepts the same route specs; dynamic `payTo`/`price` receive the x402 request
context. `radius.http(...)` returns an `x402HTTPResourceServer` for adapters' `…FromHTTPServer`
variants, and `radius.server` can be used with any `HTTPAdapter` of your own for stacks nobody
has an adapter for yet.

What you get, on the wire, with no Radius-specific client knowledge required:

- Unpaid request → `402` with a `PAYMENT-REQUIRED` header: `exact` scheme, SBC via EIP-3009
  (the transfer method the facilitator lists first, so no approval and no gas for the payer;
  Permit2 is offered only if a facilitator lists it first), with `eip2612GasSponsoring` declared
  when the facilitator supports it, which lets a first-time Permit2 payer skip the approval
  transaction.
- Paid request (`PAYMENT-SIGNATURE`) → settled on Radius through the Radius facilitator
  **before** your handler runs, with `/settle` as the only facilitator call (core makes no
  separate `/verify`). `settle: 'after'` switches to the x402 default flow: `/verify`, your
  handler, then `/settle`. Either way a `PAYMENT-RESPONSE` header with the transaction hash
  comes back.
- The receipt in the handler (second argument / `c.get('radiusPayment')`), and `onSettled` for
  logging with every adapter: it receives the `Request` (web-standard handler), the Hono context,
  or the x402 request context (`createRadiusServer`). `onSettled` records settlement, not
  delivery: in the default flow it fires before the handler, and errors it throws are logged, not
  surfaced. Keep the receipt and the delivery outcome separately, and reconcile a paid 5xx (or an
  uncertain 502) against the transaction before the buyer pays again.
- `eip2612GasSponsoring` is declared only when the facilitator's `/supported` lists it
  (`gasSponsoring: true | false` overrides), so clients never send a permit nobody will honour.
- No I/O at module scope (Workers-safe): the SDK's handlers fetch the facilitator's `/supported`
  lazily on the first paid request after each cold start. The upstream adapters fetch it at
  construction by default (fine on Node; pass their `syncFacilitatorOnStart: false` and call
  `radius.server.initialize()` yourself where module-scope I/O is forbidden). Server bundle is
  ~65 KiB gzipped, no viem.

Any x402 v2 client can pay it: verified with `radius-cli wallet pay` (which uses
`createRadiusFetch` from 0.2.0, and paid the SDK's 402s with its hand-rolled client before that)
against `examples/worker-plain` under `wrangler dev`, `examples/express-seller` on Node, and the
Hono `examples/worker-seller`, all on testnet.

Add `mpp: { secretKey }` and the same routes also accept MPP payments; see
[Protocols](#protocols-x402-and-mpp).

### Add Radius to an x402 server you already run

If your server already owns its `x402ResourceServer` and its verify, work and settle steps,
register Radius on it instead of replacing it. The functions below share one options object.

```ts
import { x402ResourceServer } from '@x402/core/server';
import { assertRadiusSupported, radiusFacilitators, registerRadius } from 'radius-sdk/server';

const radius = { networks: ['mainnet', 'testnet'], settle: 'after' } as const;

// Radius's facilitators go first: core sends a network to the first facilitator that lists it.
const server = registerRadius(new x402ResourceServer([...radiusFacilitators(radius), yourFacilitator]), radius);

await server.initialize();
assertRadiusSupported(server, radius);   // throws if no facilitator reported `exact` on a network
```

- `x402ResourceServer` cannot gain facilitators after it is built, so create the list with
  `radiusFacilitators()` first. Each reports only its own network, so it cannot capture another's.
  `registerRadius()` registers the Radius `exact` scheme per network and returns the server.
- `settle` is required, because it decides whether core calls `/verify` and your pipeline cannot
  work without knowing. `'before'` is the `upfront` payment flow: core does not call `/verify`,
  and `server.verifyPayment()` answers `isValid: true` **without checking the payment**; `/settle`
  validates, and you must run it before the work. `'after'` is the `authorization` flow:
  `verifyPayment()` calls `/verify` (a dry run), you do the work, then `settlePayment()`. Use
  `'after'` for a verify, work, settle pipeline.
- `assertRadiusSupported()` guards a failure core hides: it skips a facilitator it cannot reach
  while another answers, which would leave Radius offered in 402s but unable to settle (or settled
  by a facilitator you did not configure). Call it after `initialize()`. It passes only when the
  facilitator from `radiusFacilitators()` is the one that reported `exact` for each network, so a
  network answered by another facilitator in your list fails it too.
- A facilitator call that gets no answer (a network error, a non-x402 error body) throws
  `FacilitatorResponseError`: the outcome is unknown, and a settle may have reached the chain.
  Answer with a 5xx, not as a rejected payment.
- You build the routes and 402s, so declare `eip2612GasSponsoring` yourself if you want it (the
  scheme removes the declaration when the facilitator does not support it). Base needs its own
  facilitator: `networks: [{ network: 'base', facilitator: { url } }]`.
- `networks` takes the same entries as `createRadiusServer`, default Radius mainnet; `gasSponsoring`
  is the same option.

## Make payments (buyer / agent)

```ts
import { createRadiusFetch, getPaymentReceipt, RadiusPaymentError } from 'radius-sdk/client';

const payFetch = createRadiusFetch({
  network: 'testnet',
  signer: process.env.RADIUS_PRIVATE_KEY,   // or any viem account / { address, signTypedData }
  maxPerRequest: '$0.05',                   // required, hard per-request ceiling
  onPaymentRequired: (offer) => offer.payTo === TRUSTED_SELLER,   // optional approve/decline hook
});

const res = await payFetch('https://seller.example/api/lookup?ip=1.2.3.4');
const receipt = getPaymentReceipt(res, payFetch.network);   // { success, transaction, payer, explorerUrl, … }
```

- Pays x402 and [MPP](#protocols-x402-and-mpp) challenges, x402 first when a server offers both.
- Pays only on the configured network(s), each in its asset; anything else throws a
  `RadiusPaymentError` with a `code` (`network_mismatch`, `asset_mismatch`, `no_compatible_offer`,
  `price_above_limit`, `insufficient_balance`, `declined`, `payment_rejected`, …) before anything is signed. Of the
  compatible offers the first one within `maxPerRequest` is taken: networks in your order, offers
  on a network in the server's order (its preference), the same as `radius-cli`.
  `payment_rejected` and `invalid_challenge` carry the server's `Response` in `details.response`
  so you can log what it said.
- Several networks: `networks: ['mainnet', 'base']` instead of `network` pays on whichever of them
  the server accepts, preferring the first. `offer.network` says which one an offer is on (its
  `asset` has the symbol and decimals), a USD `maxPerRequest` is converted for each network's
  asset, and `payFetch.on('base')` gives the wallet helpers below for that network. When the
  server accepts more than one of them, the payer's balance on each is read first and the first
  network in your order that covers the price wins, so a wallet funded only on Base still pays a
  server that also takes Radius; none funded throws `insufficient_balance`, naming each.
  `preferFunded: false` skips the reads and keeps pure preference order. An injected wallet (MetaMask) signs only for the chain it is connected to, so it takes
  that one network.
- The signing window (`validBefore` / Permit2 `deadline`) is the server's `maxTimeoutSeconds`
  capped at 600 s: an authorisation the facilitator never settles stays redeemable until then.
- Schemes, a superset of what `radius-cli wallet pay` pays: x402 v2 `exact` (Permit2 or EIP-3009)
  and `upto` (Permit2 via the x402UptoPermit2Proxy, witness bound to the facilitator address the
  402 names), plus x402 v1 `exact` (EIP-3009, challenge in the JSON body, payment in `X-PAYMENT`).
  The offer passed to `onPaymentRequired` says which (`offer.scheme`, `offer.x402Version`). For
  `upto`, `offer.amount` and `maxPerRequest` are about the authorised maximum; the receipt carries
  the amount actually charged, which is validated against the signed maximum (`invalid_receipt`
  otherwise). The Radius facilitator does not advertise `upto` yet, so it is unit-tested only.
- Redirects: `fetch` follows them before the 402 (its limit of 20) and the request is paid at the final URL
  (`response.url`), with the price cap and `onPaymentRequired` applied to that offer. For GET and HEAD that
  is all there is to it. POST and other methods are where x402 clients diverge (`@x402/fetch` and
  `@x402/axios` replay the original request through redirects, the Go client pays per hop, the Python
  httpx client does not follow by default); we replay the original method and body at the final URL, even
  though after a 301, 302 or 303 fetch has already turned a POST into a GET on the way to the 402. The paid
  request is sent with `redirect: 'manual'`. If the seller redirects after payment, the redirect is
  followed by fetch's rules (303 becomes a GET, a 301/302 POST becomes a GET, other methods are kept,
  307/308 repeat the method and body; HEAD stays HEAD), never with the payment header, and without
  `Authorization` or `Cookie` on another origin; `onPaid` gets the receipt from the redirect's `PAYMENT-RESPONSE`, and the final response
  carries that header. In browsers `redirect: 'manual'` yields an opaque response (status 0), which cannot
  be followed.
- Permit2 approval handled either way: when the server's facilitator sponsors it
  (`eip2612GasSponsoring`), a wallet holding only SBC pays without any on-chain transaction; when
  it does not, the SDK sends one unlimited approval from the signer (`permit2Approval: 'auto'`,
  the default; `'never'` throws `approval_required`). `onApprovalRequired` sees every allowance
  change the client makes, with `request.reason` (`payment`, `approvePermit2`, `approve`), and
  can veto it (`declined`, carrying the request). Gas for that one transaction comes from SBC via
  the Turnstile on Radius, so keep ~0.01 SBC spare; elsewhere it is the chain's native token (ETH
  on Base).
- A sponsored raw approve (`erc20ApprovalGasSponsoring`) is gated like the on-chain one
  (`permit2Approval`, `onApprovalRequired`); EIP-2612 permits are part of the payment and are not.
- `maxPerRequest` is a per-request ceiling, **not** a cumulative budget. An agent that loops can
  exceed any total unless you enforce one around it.
- Wallet helpers on the same object, for the first network (`payFetch.on(network)` for the
  others): `address`, `balance()` (the payment asset only), `balances()` (native RUSD,
  SBC and the aggregate, separately; see [Balances](#balances-native-rusd-vs-stablecoins)),
  `send(to, '$0.05')`, `permit2Allowance()`, `approvePermit2()`, `getSettlement(txHash)` to
  reconcile a payment on-chain before charging again, `fund()` for a faucet drip (testnet ~0.5 SBC,
  mainnet ~0.01 SBC/day), and `client` (the underlying `@x402/core` client).
- Config from the environment with radius-cli's variable names:
  `createRadiusFetch({ ...radiusEnv(process.env), signer })` reads `RADIUS_NETWORK`,
  `RADIUS_RPC_URL`, `RADIUS_FACILITATOR_URL`, `RADIUS_ASSET_ADDRESS` (alias `RADIUS_SBC_ADDRESS`), `RADIUS_PRIVATE_KEY`,
  `RADIUS_MAX_PER_REQUEST`; on Workers pass `c.env`.

## ERC-20 interactions

Metadata, allowance, `approve`, `transfer`, `transferFrom` and `Transfer` events as viem actions.
Reads take any viem client; writes take a wallet client with an account and wait for the receipt
(Radius finality is sub-second). Amounts are `bigint` atomic units or a display string such as
`"1.5"`, parsed with the token's decimals. Like the other viem-backed actions, they are exported
from `radius-sdk/client`.

```ts
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { radiusTestnet, SBC } from 'radius-sdk';
import { erc20Actions, transferKey } from 'radius-sdk/client';

const wallet = createWalletClient({ account: privateKeyToAccount(KEY), chain: radiusTestnet.chain, transport: http() })
  .extend(erc20Actions());                                  // preset chain: SBC by default

await wallet.getTokenMetadata();                             // { name: 'Stable Coin', symbol: 'SBC', decimals: 6, totalSupply }
await wallet.transfer({ to, amount: '1.50' });               // { hash, status: 'success' | 'reverted', explorerUrl }
await wallet.approve({ spender, amount: 2_000_000n });       // atomic units; wait: false returns { status: 'pending' } after sending; gas sets the limit
await wallet.getAllowance({ owner: wallet.account.address, spender });
await wallet.transferFrom({ from, to, amount: '0.10' });     // spend an allowance granted to this account
await wallet.getTransfers({ to, fromBlock, toBlock });       // decoded Transfer logs, (blockNumber, logIndex) order
const unwatch = wallet.watchTransfers({
  to,
  fromBlock: checkpoint + 1n,                                // omit for new transfers only
  onTransfer: (t) => { if (!seen.has(transferKey(t))) handle(t); },
  onCheckpoint: (block) => save(block),                      // persist: resume from here after a restart
});

// Or call the actions directly, viem style, on any client:
import { transfer, getAllowance } from 'radius-sdk/client';
await transfer(wallet, { token: '0x…', to, amount: '3' });   // a bare address: decimals() is read on-chain
```

- **Default token.** On the preset networks (recognised by chain id) every action defaults to the
  network's payment asset: SBC on Radius, USDC on Base. A client on any other chain has no
  default: a custom network's `asset` is not visible from `client.chain`, and quietly using SBC's
  address would send `approve` / `transfer` to the wrong contract, so the action throws a `config`
  error until you pass `token`, or extend with `erc20Actions({ network })` (checked against the
  client's chain) or `erc20Actions({ token: network.asset })`.
- **Receipts.** Writes wait for the receipt and report `status: 'success' | 'reverted'`. With
  `wait: false` they return right after sending with `status: 'pending'`, which says nothing about
  the outcome; wait for the receipt yourself before treating it as done. A `gas` limit skips
  `eth_estimateGas`, the only pre-send revert check.
- **Block windows.** Radius block numbers are unix milliseconds, and a node answers `eth_getLogs`
  only for spans of at most `MAX_LOG_RANGE` (1 000 000 blocks, about 16.7 minutes; wider spans
  fail with `-33002 block range is too wide`). `getTransfers` therefore defaults `fromBlock` to
  `toBlock - MAX_LOG_RANGE` (`toBlock` defaults to the head) and fetches a wider range in
  sequential chunks of `maxBlockRange` (default `MAX_LOG_RANGE`), refusing more than
  `MAX_LOG_CHUNKS` (1 000) calls in one go; page anything larger yourself.
- **Watching.** `watchTransfers` is the SDK's own poller (Radius has no `eth_newFilter`). Each
  poll fetches `next..head` in chunks, delivers every transfer in `(blockNumber, logIndex)` order
  through `onTransfer` (awaited), then advances and calls `onCheckpoint(lastBlock)`. Any failure,
  including a throwing `onTransfer`, goes to `onError` and leaves the cursor where it was, so the
  range is retried on the next poll and nothing is skipped: delivery is at-least-once, never
  at-most-once. Persist the checkpoint and resume with `fromBlock: checkpoint + 1n`; dedupe on
  `transferKey(t)` (`transactionHash:logIndex`) for the range that may be redelivered. Without
  `fromBlock` the watcher starts at the current head and delivers new transfers only. Backfill
  and live delivery are one ordered stream, so there is no race between a history query and the
  watcher. Radius has sub-second, single-block finality and no reorgs, so no confirmation lag is
  applied. viem's `watchContractEvent` is not used: its polling fallback issues one `getLogs` for
  the whole gap since the last poll, so any pause over `MAX_LOG_RANGE` wedges it for good.
- **Approvals.** `createRadiusFetch(...)` gains `allowance(spender)` and `approve(spender, amount)`
  for the payment asset next to `send`. `approve` passes through `onApprovalRequired`
  (`reason: 'approve'`) exactly like the Permit2 approvals do, so one policy hook sees, and can
  veto, every allowance the payment client grants. The plain `erc20Actions().approve` on your own
  wallet client has no hook: it is you signing, not the SDK.

## Permit2

Actions for the canonical [Permit2](https://github.com/Uniswap/permit2) contract (`PERMIT2_ADDRESS`,
the same on every Radius network), covering both of its flows. `permit2Actions()` is a client
extension; each action is also exported on its own. All of them come from `radius-sdk/client`.

```ts
import { permit2Actions } from 'radius-sdk/client';
const owner = createWalletClient({ account, chain: radiusTestnet.chain, transport: http() }).extend(permit2Actions());
const spender = createWalletClient({ account: spenderAccount, chain: radiusTestnet.chain, transport: http() }).extend(permit2Actions());

// Once per token: let Permit2 move the owner's SBC (unlimited by default, the x402 one-time approval).
await owner.getPermit2Approval({ owner: owner.account.address });     // ERC-20 allowance granted to Permit2
await owner.approvePermit2();                                          // approvePermit2({ amount: '5' }) to cap it

// SignatureTransfer (what x402 uses): one-off permit signed off-chain, submitted by the spender.
const signed = await owner.signPermit2Transfer({ amount: '0.01', spender: spender.account.address });
//   { permit: { permitted: { token, amount }, nonce, deadline }, spender, owner, signature, chainId }
await spender.permit2TransferFrom({ signed, to: spender.account.address });   // amount: pull less than permitted
await spender.isPermit2NonceUsed({ owner: signed.owner, nonce: signed.permit.nonce });   // true afterwards

// With a witness (extra data the signature is bound to, e.g. x402's `Witness(address to,uint256 validAfter)`):
const witness = { typeName: 'Witness', types: { Witness: [{ name: 'to', type: 'address' }, { name: 'validAfter', type: 'uint256' }] }, value: { to, validAfter: 0n } };
const w = await owner.signPermit2Transfer({ amount: '0.01', spender: proxy, witness });
await spender.permit2TransferFrom({ signed: w, to });                  // calls permitWitnessTransferFrom with the hash + type string

// AllowanceTransfer (Uniswap-style): a signed allowance the spender can draw on until it expires.
const allowance = await owner.signPermit2Allowance({ amount: '5', spender: spender.account.address, expiration: now + 86_400 });
await spender.permit2Permit({ signed: allowance });                    // records it in Permit2
await spender.permit2AllowanceTransferFrom({ from: owner.account.address, to, amount: '1' });   // repeatable
await spender.getPermit2Allowance({ owner: owner.account.address, spender: spender.account.address });   // { amount, expiration, nonce }
```

Nonces: SignatureTransfer nonces are random 256-bit values (`randomPermit2Nonce()`, the default);
AllowanceTransfer nonces are sequential per (owner, token, spender) and read from Permit2 when
omitted. Deadlines default to 600 s, the same cap the x402 client applies. The EIP-712 domain,
type sets (`PERMIT_TRANSFER_FROM_TYPES`, `PERMIT_SINGLE_TYPES`), `permit2WitnessTypeString` and
`permit2WitnessHash` are exported from `radius-sdk/client` for anyone assembling calls by hand; the witness type string is
derived with EIP-712's ordering rule and checked against the x402 layout in the tests.

## Balances: native RUSD vs stablecoins

Radius differs from other EVM chains here. `eth_getBalance` (viem's `getBalance`, MetaMask's
balance, `cast balance`) returns the account's native RUSD **plus** its convertible stablecoin
holdings (SBC) valued 1:1 and rescaled to 18 decimals: the total the account can spend, since
the Turnstile converts SBC into RUSD inline when a transaction needs it. Reading `eth_getBalance`
and an SBC `balanceOf` and adding them double-counts the SBC. The EVM itself is unchanged: the
`BALANCE` opcode (Solidity's `address.balance`) sees only the native amount.

The SDK reports each part on its own, as plain viem actions or as a client extension. They are
exported from `radius-sdk/client` (the entry point that requires viem); the root entry point
keeps only their types:

```ts
import { createPublicClient, http } from 'viem';
import { radiusTestnet, SBC } from 'radius-sdk';
import { radiusActions, getBalances, getNativeBalance, getTokenBalance } from 'radius-sdk/client';

const client = createPublicClient({ chain: radiusTestnet.chain, transport: http() }).extend(radiusActions());

const b = await client.getBalances({ address });
b.native.raw            // 2345678000000000000n  — native RUSD only (wei)
b.native.aggregate      // 12345678000000000000n — what eth_getBalance / client.getBalance() returns
b.native.convertible    // 10000000000000000000n — aggregate − raw: SBC value the Turnstile can convert
b.tokens[0]             // { symbol: 'SBC', atomic: 10000000n, formatted: '10', decimals: 6, convertible: true, … }
b.totalFormatted        // '12.345678' — raw + convertible tokens at 1:1, 18 decimals

// Individually, or without the extension:
await client.getNativeBalance({ address });                    // bigint, native RUSD only
await client.getTokenBalance({ address, token: SBC });         // raw ERC-20 balanceOf
await getNativeBalance(client, { address });                   // same actions, viem style
await getBalances(client, { address, tokens: [SBC, { address: '0x…', symbol: 'USDX', decimals: 18 }] });
```

`getBalances` issues one `eth_getBalance`, one `eth_call` per token and one `eth_call` for the
native balance, in parallel, and accepts `blockNumber` / `blockTag`. Default tokens are the
network's payment asset (SBC), chosen from the client's chain id (or a `network` option).

How the raw native balance is read: an `eth_call` with no `to` whose init code is
`PUSH20 <address> BALANCE PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN`, so it needs no deployed
contract and works on any node that executes standard EVM. `b.native.rawSource` says `evm` when
that succeeded. Should a node refuse the call, `getBalances` falls back to subtracting the
`convertible` tokens from the aggregate (`rawSource: 'derived'`, with the error in `rawError`);
`nativeBalance: 'evm' | 'derived' | 'auto'` selects the strategy explicitly. Mark extra tokens
`convertible: true` only if the Turnstile counts them in `eth_getBalance` (today: SBC); other
tokens are reported in `tokens` but not valued 1:1 in `total`.

## Networks and currency

| Preset | Chain | Asset | Default facilitator |
| --- | --- | --- | --- |
| `'mainnet'` / `'radius'` (default) | Radius, 723487 | SBC | Radius |
| `'testnet'` / `'radius-testnet'` | Radius testnet, 72344 | SBC | Radius testnet |
| `'base'` | Base, 8453 | USDC | none: sellers name one |
| `'base-sepolia'` | Base Sepolia, 84532 | USDC | x402.org |

```ts
import { radiusTestnet, baseSepolia, definePaymentNetwork, resolveNetwork } from 'radius-sdk';
import { createPublicClient, http } from 'viem';

resolveNetwork('testnet', { rpcUrl: 'https://rpc.testnet.radiustech.xyz/YOUR_KEY' });
resolveNetwork('base', { rpcUrl: 'https://base-mainnet.example/KEY' });

// Any other EVM chain: a viem Chain plus its payment asset (and a facilitator for sellers).
const arbitrum = definePaymentNetwork({
  chain: myViemChain,
  asset: { address: '0x…', symbol: 'USDC', decimals: 6, name: 'USD Coin', version: '2' },   // EIP-712 domain
  facilitatorUrl: 'https://facilitator.example',
});

// Every network carries its viem Chain; use it for your own viem clients.
createPublicClient({ chain: radiusTestnet.chain, transport: http() });
```

Chain identity lives in viem `Chain` objects (`radiusMainnetChain`, `radiusTestnetChain`,
`baseChain`, `baseSepoliaChain`), defined here with the same values as viem's own (importing
`viem/chains` would load every chain viem knows). A `PaymentNetwork` is one of those chains
(`network.chain`, the source of truth) plus its payment `asset`, default `facilitatorUrl`,
`faucetUrl` (Radius only), `v1Names` (how x402 v1 challenges name it, e.g. `base`) and `radius`
(true on Radius: `eth_getBalance` includes convertible stablecoins); `chainId`, `network` (CAIP-2
`eip155:<id>`), `rpcUrl`, `explorerUrl` and `testnet` are derived from the chain. An `rpcUrl`
override yields a network whose `chain` also uses that RPC.

Both `radiusPayments` and `createRadiusFetch` accept `network`, plus `rpcUrl`, `facilitatorUrl`,
and `asset` overrides. USD prices (`'$0.01'`) are converted with the asset's decimals and assume a
USD-pegged asset, which every preset is.

**Accepting more than one network.** `networks` instead of `network` makes every route offer one
payment option per network, in that order, each settled by its own facilitator. Base mainnet has
no default facilitator, so name one:

```ts
const pay = radiusPayments({
  networks: ['mainnet', { network: 'base', facilitator: { url: 'https://your-base-facilitator.example' } }],
  payTo: '0xYourWallet',   // same address on every EVM chain
  routes: { 'GET /api/lookup': '$0.001' },   // 0.001 SBC on Radius, 0.001 USDC on Base
});
```

Receipts (`payment.network`, `explorerUrl`) say which network a payment settled on. A price given
as `{ amount, asset }` names one token, so it is rejected when several networks are configured.

**Facilitator.** Defaults to the network's (the Radius facilitator on Radius), with a live
`/supported` lookup. Options: `facilitator: { url, apiKey }` for another hosted facilitator,
`facilitator: { live: false }` to skip the lookup and use the built-in Radius answer (Radius only;
faster cold start, but stale if the facilitator changes), or `facilitator: myClient` where
`myClient` implements `FacilitatorClient` from `@x402/core/server` (`getSupported`, `verify`,
`settle`) for a self-hosted facilitator or one with its own auth (for example a JWT-authenticated
hosted facilitator). With `networks`, top-level `facilitator` and overrides apply to the first
network; give the others theirs in `{ network, facilitator }`.

## Protocols: x402 and MPP

Besides x402, the SDK speaks [MPP](https://mpp.dev) (the Machine Payments Protocol: the HTTP
`Payment` authentication scheme, [draft-httpauth-payment](https://paymentauth.org)) for its `evm`
charge method. Both end in the same thing, an EIP-3009 `transferWithAuthorization` of the network's
stablecoin, settled by the same x402 facilitator; only the envelope differs:

| | x402 | MPP |
| --- | --- | --- |
| 402 | `PAYMENT-REQUIRED` (offers in `accepts`) | `WWW-Authenticate: Payment …` (one challenge per network) |
| Paid retry | `PAYMENT-SIGNATURE` | `Authorization: Payment …` |
| Receipt | `PAYMENT-RESPONSE` | `Payment-Receipt` |
| Payment methods | `exact` (EIP-3009 or Permit2), `upto` | `evm` charge (EIP-3009) |

The SDK's MPP is this one method: `method="evm"`, `intent="charge"`, an EIP-3009 authorization
settled through the x402 facilitator. It is not a drop-in for a server whose MPP rail is Tempo
through `mppx`: a Tempo challenge has `method="tempo"` and a different `request`, the SDK never
emits one, and `createRadiusFetch` rejects it (`no_compatible_offer`). For such a server, add
Radius over x402 ([above](#add-radius-to-an-x402-server-you-already-run)), or add `mppx`'s own
`evm` method (the one this SDK is tested against) next to Tempo.

**Buyers** pay either. `protocols` (default `['x402', 'mpp']`) is the preference order when a 402
offers both; the protocol picked first, then networks in your order, except that a network your
balance covers beats an unfunded one whichever protocol offers it. `offer.protocol` says which
one an offer came from (an MPP offer carries its `challenge`), and receipts carry `protocol` too.
The credential goes in `Authorization`, so a request that already sends its own `Authorization`
header is not paid over MPP. MPP payments need no approval and no gas.

**Sellers** opt in per server:

```ts
const pay = radiusPayments({
  networks: ['mainnet', { network: 'base', facilitator: { url: 'https://your-base-facilitator.example' } }],
  payTo: '0xYourWallet',
  routes: { 'GET /api/lookup': '$0.001' },
  mpp: { secretKey: env.MPP_SECRET_KEY },   // ≥ 32 random characters: `openssl rand -base64 32`
});
```

Every 402 then also carries an MPP challenge per network, mirroring the x402 offers (same price,
asset, recipient and expiry). A credential is checked without stored state, its challenge id
being an HMAC of the challenge's parameters under `secretKey`, so every instance serving the same
routes needs the same key. The check covers the realm (`mpp.realm`, default the request's host),
expiry, the route's current price, and the authorization's nonce, which is bound to the challenge;
the facilitator then verifies and settles it as an x402 `exact` EIP-3009 payment, before or after
the handler as `settle` says. The handler's `payment` and `onSettled` receive the receipt with
`protocol: 'mpp'`, and the response carries `Payment-Receipt`. MPP is served by
`radiusPayments()` (web-standard and Hono); routes mounted through the upstream x402 adapters only
see x402. Interop is tested against `mppx`, the reference implementation, in both directions.

## Layout

| Path | What |
| --- | --- |
| `src/` | `networks`, `balances`, `erc20`, `permit2`, `amounts`, `receipt`, `settlement`, `schemes`, `env`, `errors`, `mpp` (MPP wire format); `server/` (seller core: web-standard handler, x402 resource server, facilitator, scheme, MPP payments); `hono/` (Hono wrapper); `client/` (buyer) |
| `examples/worker-plain` | Worker with no framework, the web-standard handler: free `/`, paid `/api/lookup` and `/api/query` (`pnpm --filter radius-worker-plain dev`, port 8788) |
| `examples/worker-seller` | Same API on Hono (`pnpm --filter radius-worker-seller dev`) |
| `examples/express-seller` | Same API on Express through `@x402/express` (`pnpm --filter radius-express-seller start`, port 8789) |
| `examples/astro-seller` | Astro API route: validate the article before charging, then deliver it paid (`pnpm --filter radius-astro-seller dev`, port 8790) |
| `examples/agent-buyer` | `buy.mjs` (pay a URL), `fresh-wallet.mjs` (gasless proof from a new wallet), `permit2-pull.mjs` (sign a Permit2 transfer off-chain, pull it from another account) |
| `examples/demo-dapp` | Test-dapp style page exercising both sides in the browser (burner wallet or MetaMask) |
| `test/` | unit tests (facilitator and RPC mocked; `client-parity.test.ts` pins the wire format against radius-cli's; `balances.test.ts` runs the native-balance init code in a real EVM; `erc20.semantics.test.ts` runs the ERC-20 actions against `evmNode.ts`, a JSON-RPC node backed by @ethereumjs/evm executing the forge-compiled `fixtures/TestToken` (rebuild with `fixtures/build.sh` after editing the .sol; the artifact is committed because CI has no forge); `mpp*.test.ts` check MPP against `mppx`, the reference implementation, in both directions); `test/e2e` real settlement, balance reconciliation and ERC-20 round trips on testnet or mainnet (`RADIUS_E2E=1 RADIUS_PRIVATE_KEY=… [RADIUS_NETWORK=mainnet] pnpm test:e2e`) |

Built on `@x402/core` (server and client) and `@x402/evm` (client signing only), both peer dependencies you install, plus viem (client) and `@noble/hashes` (MPP's keccak-256 on the viem-free server).
