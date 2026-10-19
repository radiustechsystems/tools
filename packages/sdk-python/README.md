# radius-sdk (Python)

Accept and make [Radius](https://radiustech.xyz) payments over standard [x402 v2](https://x402.org),
and optionally [MPP](https://mpp.dev), from Python. This is the Python port of the TypeScript
[`radius-sdk`](../sdk): the same wire format, defaults, offer selection, error codes and
safety rules, on Python's stack. Sellers run on any ASGI framework (Starlette, FastAPI) or on the
upstream x402 FastAPI middleware. Buyers and agents pay with an `httpx`-based client. Radius
mainnet and SBC are the defaults; Base (USDC) and any other EVM chain can be added alongside.

Pre-1.0: minor versions may change the API. Release notes are in [CHANGELOG.md](./CHANGELOG.md).

| Module | What | Install |
| --- | --- | --- |
| `radius_sdk` | networks, amounts, receipts, errors, `radius_env`, MPP wire format | `radius-sdk` |
| `radius_sdk.server` | `radius_payments()` handler for Starlette requests; `RadiusServer` for the upstream x402 middleware; `proxy_to` | `radius-sdk[server]` |
| `radius_sdk.starlette` | `RadiusPaymentsMiddleware`, ASGI middleware for a whole Starlette or FastAPI app | `radius-sdk[server]` |
| `radius_sdk.client` | `create_radius_fetch()` paying client, wallet helpers | `radius-sdk[client]` |
| `radius_sdk.rpc`, `.balances`, `.erc20`, `.permit2`, `.settlement` | JSON-RPC client; balance, ERC-20, Permit2 and settlement actions | `radius-sdk[client]` |

Requires Python 3.10 or later. Built on the `x402` Python package (pinned, like the TypeScript SDK
pins `@x402/core`), `httpx`, and, for buyers, `eth-account`.

## Install

```sh
pip install "radius-sdk[server]"   # seller
pip install "radius-sdk[client]"   # buyer / agent
pip install "radius-sdk[all]"      # both
```

The root and server modules never import `eth-account`: a seller install carries no signing code.

## Accept payments (seller)

**Starlette handler**: `radius_payments()` returns a handler for Starlette requests. Wrap an
endpoint with `pay.wrap(endpoint)`, or call `await pay(request, next)` from your own route. Paid
handlers receive the settled receipt as a second argument; a handler that takes only `request`
works too.

```python
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from radius_sdk.server import radius_payments

pay = radius_payments(
    network="testnet",                 # default "mainnet"; or "base", "base-sepolia", …
    pay_to="0xYourWallet",             # or lambda request: …
    routes={
        "GET /api/lookup": {"price": "0.001", "description": "One lookup"},
        "POST /api/query": "0.01",                        # shorthand
        "GET /api/raw": {"price": {"amount": "100"}},     # atomic units (6 decimals for SBC)
    },
)

async def lookup(request, payment):
    return JSONResponse({"ok": True, "paid_by": payment.payer if payment else None})

app = Starlette(routes=[Route("/api/lookup", pay.wrap(lookup))])
```

USD prices such as `"0.001"` or `"$0.001"` are converted with each network's asset decimals.

**Validate, then pay.** With the default `settle="before"`, funds move before your handler runs, so
anything the handler discovers afterwards (missing record, failed lookup) is a paid error. Do the
fallible work before calling `pay`, return the unpaid 404 there, and hand the prepared result to
the paid handler:

```python
@app.get("/articles/{slug}")
async def article(slug: str, request: Request):
    found = await load_article(slug)
    if found is None:
        return JSONResponse({"error": "not found"}, status_code=404)        # nothing charged
    return await pay(request, lambda _request, _payment: JSONResponse(found))   # charge, then deliver
```

**Middleware for a whole app** (Starlette or FastAPI): the same options. Dynamic `pay_to` / `price`
and `on_settled` receive the Starlette `Request`, and paid handlers read
`request.state.radius_payment`. In the default flow the downstream response streams through.

```python
from fastapi import FastAPI, Request
from radius_sdk.starlette import RadiusPaymentsMiddleware

app = FastAPI()
app.add_middleware(
    RadiusPaymentsMiddleware,
    network="testnet",
    pay_to="0xYourWallet",
    routes={"GET /api/lookup": {"price": "0.001", "description": "One lookup"}},
)

@app.get("/api/lookup")
async def lookup(request: Request):
    return {"ok": True, "paid_by": request.state.radius_payment.payer}
```

**In front of an origin you do not change** (any language): `proxy_to(origin)` forwards a request
with its method, path and query. Use it as the paid handler: `pay.wrap(proxy_to(origin))`. It
buffers the body, drops `Host`, hop-by-hop headers and payment credentials (`Authorization: Bearer …`
passes through), and asks for `Accept-Encoding: identity`. It drops the `Content-Encoding` of a body
httpx decoded anyway, returns redirects unfollowed, and copies the response headers so the receipt
can be added.

**The upstream x402 middleware**: `RadiusServer` provides the Radius resource server and routes,
and x402's FastAPI middleware provides the request handling:

```python
from x402.http.middleware.fastapi import payment_middleware
from radius_sdk.server import create_radius_server

radius = create_radius_server(network="testnet")
middleware = payment_middleware(radius.routes(pay_to="0xYourWallet", routes={"GET /api/lookup": "0.001"}), radius.server)

@app.middleware("http")
async def x402(request, call_next):
    return await middleware(request, call_next)
```

What you get on the wire is the TypeScript SDK's 402 and receipt (the interop tests compare the
decoded headers of the two sellers):

- Unpaid request → `402` with a `PAYMENT-REQUIRED` header: `exact` scheme, SBC via the transfer
  method the facilitator lists first, with `eip2612GasSponsoring` declared when the facilitator's
  `/supported` lists it (`gas_sponsoring=True | False` overrides).
- Paid request (`PAYMENT-SIGNATURE`) → settled on Radius through the Radius facilitator **before**
  your handler runs (`settle="after"` switches to the x402 default flow), then a `PAYMENT-RESPONSE`
  header with the transaction hash.
- The receipt reaches the handler and `on_settled`. `on_settled` records settlement, not delivery: in
  the default flow it fires before the handler, and errors it raises are logged, not surfaced. Keep
  the receipt and the delivery outcome separately, and reconcile a paid 5xx (or an uncertain 502)
  against the transaction before the buyer pays again.
- A facilitator call that fails without the facilitator's own answer (a network error, an error page)
  is answered `502`, never `402`: a settle may have reached the chain. The facilitator's own
  rejections stay `402`.
- No I/O at import or construction. The facilitator's `/supported` is fetched lazily on the first
  paid request, off the event loop. A failed fetch answers 502 and is retried on the next request.

Add `mpp={"secret_key": ...}` and the same routes also accept MPP payments; see
[Protocols](#protocols-x402-and-mpp).

## Make payments (buyer / agent)

```python
import os
from radius_sdk import get_payment_receipt
from radius_sdk.client import create_radius_fetch

pay = create_radius_fetch(
    network="testnet",
    signer=os.environ["RADIUS_PRIVATE_KEY"],   # or an eth-account LocalAccount / {address, sign_typed_data}
    max_per_request="0.05",                    # required, hard per-request ceiling
    on_payment_required=lambda offer: offer.pay_to == TRUSTED_SELLER,   # optional approve/decline hook
)

res = await pay("https://seller.example/api/lookup?ip=1.2.3.4")          # httpx.Response
receipt = get_payment_receipt(res, pay.network)   # PaymentReceipt(success, transaction, payer, explorer_url, …)
await pay.post(url, json={"q": "radius"})          # also .get / .put / .delete / .head / .request
```

The client behaves exactly as the TypeScript `createRadiusFetch`; see that README for the full
rationale behind each rule:

- Pays x402 and MPP challenges, x402 first when a server offers both (`protocols=("mpp", "x402")`
  reverses that).
- Pays only on the configured network(s), each in its asset. Anything else raises
  `RadiusPaymentError` with a `code` before anything is signed: `network_mismatch`,
  `asset_mismatch`, `no_compatible_offer`, `price_above_limit`, `insufficient_balance`, `declined`,
  `payment_rejected`, `invalid_challenge`, `invalid_receipt`, `approval_required` and the rest.
  `payment_rejected` and `invalid_challenge` carry the server's `httpx.Response` in
  `details.response`.
- Several networks: `networks=["mainnet", "base"]`. When the server accepts more than one, the
  payer's balance on each is read and the first funded network in your order wins
  (`prefer_funded=False` keeps pure preference order). `pay.on("base")` gives the wallet helpers for
  another network.
- Schemes: x402 v2 `exact` (Permit2 or EIP-3009) and `upto` (Permit2, witness bound to the
  facilitator address), and x402 v1 `exact` (EIP-3009 via `X-PAYMENT`). For `upto` the receipt's
  charged amount is validated against the signed maximum.
- The signing window is the server's `maxTimeoutSeconds` capped at 600 s.
- Redirects follow the fetch rules the TypeScript client uses. Before the 402, the request is paid at
  the final URL with the original method and body, and Authorization and Cookie are dropped on
  another origin. The paid request is never redirected with its payment header. A redirect after
  payment is followed by fetch's rules, and the receipt is copied onto the final response.
- Permit2 approval: sponsored (`eip2612GasSponsoring`) needs no transaction. Otherwise one unlimited
  approval is sent from the signer (`permit2_approval="auto"`, the default; `"never"` raises
  `approval_required`). `on_approval_required` sees, and can veto, every allowance change the client
  makes, including a facilitator-sponsored raw approve.
- `max_per_request` is a per-request ceiling, **not** a cumulative budget.
- Wallet helpers for the first network: `address`, `balance()` (`(atomic, formatted)`, the payment
  asset only), `balances()` (native RUSD, SBC and the aggregate, reported separately), `send(to, "0.05")`,
  `allowance(spender)`, `approve(spender, amount)`, `permit2_allowance()`, `approve_permit2()`,
  `get_settlement(tx_hash)` to reconcile before charging again, and `fund()` for a faucet drip. Also
  `client`, the underlying `x402ClientSync`.
- Configuration from the environment with radius-cli's variable names:
  `create_radius_fetch(**radius_env(), max_per_request="0.05")` reads `RADIUS_NETWORK`, `RADIUS_RPC_URL`,
  `RADIUS_FACILITATOR_URL`, `RADIUS_ASSET_ADDRESS` (alias `RADIUS_SBC_ADDRESS`), `RADIUS_PRIVATE_KEY`
  and `RADIUS_MAX_PER_REQUEST`. The same dict spreads into `radius_payments()`; each side ignores the
  other's keys.

Pass `http_client=httpx.AsyncClient(...)` to control the seller-facing HTTP client (timeouts,
proxies, a mock transport in tests) and `rpc_http_client=` for JSON-RPC. `RadiusFetch` is an async
context manager; `aclose()` closes the clients it created.

## Chain actions

The TypeScript SDK's viem actions, as async functions over a small JSON-RPC client.
`RpcClient` reads; `WalletClient` adds an account (a private key or eth-account `LocalAccount`) that
signs and sends transactions, with viem's fee defaults. Each module also has a class that binds a
client and a default token, standing in for viem's `.extend(...)`.

```python
from radius_sdk import radius_testnet
from radius_sdk.rpc import RpcClient, WalletClient
from radius_sdk.balances import get_balances
from radius_sdk.erc20 import Erc20Actions, transfer_key
from radius_sdk.permit2 import Permit2Actions

client = RpcClient.for_network(radius_testnet)
b = await get_balances(client, address)
b.native.raw          # native RUSD only (wei), read with the BALANCE opcode
b.native.aggregate    # what eth_getBalance returns: native + convertible SBC
b.tokens[0].atomic    # SBC balanceOf, never aggregated

wallet = WalletClient.for_network(radius_testnet, PRIVATE_KEY)
erc20 = Erc20Actions(wallet)                       # preset chain: SBC by default
await erc20.transfer(to, "1.50")                   # TxResult(hash, status, explorer_url)
await erc20.get_transfers(to=me, from_block=n)     # chunked eth_getLogs, (block, log index) order
watch = erc20.watch_transfers(handle, from_block=checkpoint + 1, on_checkpoint=save)   # at-least-once
watch()                                            # stop

permit2 = Permit2Actions(wallet)
signed = await permit2.sign_permit2_transfer("0.01", spender)
await Permit2Actions(spender_wallet).permit2_transfer_from(signed, to)
```

On Radius, `eth_getBalance` returns native RUSD **plus** convertible SBC. `get_balances` reports each
part on its own, so they are never double-counted. Block numbers are unix milliseconds, and a node
answers `eth_getLogs` for at most `MAX_LOG_RANGE` (1,000,000) blocks, so `get_transfers` and
`watch_transfers` page the range for you. The Permit2 helpers cover both flows: SignatureTransfer,
with witnesses, and AllowanceTransfer. The witness type string and hash match the TypeScript SDK's;
the interop tests check them.

## Networks and currency

| Preset | Chain | Asset | Default facilitator |
| --- | --- | --- | --- |
| `"mainnet"` / `"radius"` (default) | Radius, 723487 | SBC | Radius |
| `"testnet"` / `"radius-testnet"` | Radius testnet, 72344 | SBC | Radius testnet |
| `"base"` | Base, 8453 | USDC | none: sellers name one |
| `"base-sepolia"` | Base Sepolia, 84532 | USDC | x402.org |

```python
from radius_sdk import Chain, NativeCurrency, PaymentAsset, define_payment_network, resolve_network, NetworkOverrides

resolve_network("testnet", NetworkOverrides(rpc_url="https://rpc.testnet.radiustech.xyz/YOUR_KEY"))
arbitrum = define_payment_network(
    chain=Chain(42161, "Arbitrum One", NativeCurrency("Ether", "ETH", 18), "https://arb1.arbitrum.io/rpc"),
    asset=PaymentAsset("0x…", "USDC", 6, "USD Coin", "2"),       # EIP-712 domain name and version
    facilitator_url="https://facilitator.example",
)
```

**Accepting more than one network**: `networks=` instead of `network=`. Every route then offers one
payment option per network, in that order, each settled by its own facilitator. Base mainnet has no
default facilitator, so name one:

```python
from radius_sdk.server import ServerNetwork, radius_payments

pay = radius_payments(
    networks=["mainnet", ServerNetwork("base", {"url": "https://your-base-facilitator.example"})],
    pay_to="0xYourWallet",
    routes={"GET /api/lookup": "0.001"},   # 0.001 SBC on Radius, 0.001 USDC on Base
)
```

**Facilitator**: defaults to the network's facilitator, with a live `/supported` lookup.

- `facilitator={"url": ..., "api_key": ...}` uses another hosted facilitator.
- `facilitator={"live": False}` uses the built-in Radius answer instead of the lookup (Radius only).
- `facilitator=my_client` takes any object with async `verify` / `settle` and a synchronous
  `get_supported`, the x402 Python `FacilitatorClient` protocol.

## Protocols: x402 and MPP

The SDK also speaks [MPP](https://mpp.dev) (the HTTP `Payment` authentication scheme) for its `evm`
charge method. Both protocols end in an EIP-3009 `transferWithAuthorization` settled by the same
facilitator; only the envelope differs:

| | x402 | MPP |
| --- | --- | --- |
| 402 | `PAYMENT-REQUIRED` (offers in `accepts`) | `WWW-Authenticate: Payment …` (one challenge per network) |
| Paid retry | `PAYMENT-SIGNATURE` | `Authorization: Payment …` |
| Receipt | `PAYMENT-RESPONSE` | `Payment-Receipt` |

**Sellers** opt in with `mpp={"secret_key": os.environ["MPP_SECRET_KEY"]}`; the key must be at least
32 random characters (`openssl rand -base64 32`). Every 402 then also carries an MPP challenge per
network, mirroring the x402 EIP-3009 offers. A credential is checked without stored state: its
challenge id is an HMAC of the challenge's parameters, so every instance must share the key. The
check covers the realm (`mpp={"realm": ...}`, default the request's host), expiry, the route's
current price, and the authorization's nonce, which is bound to the challenge. The facilitator then
verifies and settles it.

**Buyers** pay either protocol. A request that already sends its own `Authorization` header is not
paid over MPP. MPP payments need no approval and no gas.

## How the port is checked

`tests/` mirrors the TypeScript SDK's suites, and `tests/test_interop.py` runs the two SDKs
against each other:

- **Golden vectors**: amounts, canonical JSON, MPP challenge ids, nonces, header serialization and
  parsing (including astral-plane escapes), Permit2 witness type strings and struct hashes, network
  presets, receipt decoding and env mapping are computed by the built TypeScript SDK and compared
  with this package's output.
- **Python buyer → TypeScript seller**: `create_radius_fetch` pays `radiusPayments()` over HTTP:
  EIP-3009 in both settle modes, a POST with a body, Permit2 with a sponsored EIP-2612 permit, and
  MPP. The TypeScript seller's `@x402/core` must accept every payload, and its facilitator recovers
  every signature with viem.
- **TypeScript buyer → Python seller**: `createRadiusFetch` pays this package's handler under
  uvicorn, in the same cases, plus a rejected settlement. The Python facilitator recovers each
  signature with eth-account.
- **Same 402**: for the same configuration the two sellers return the same status, body,
  `Cache-Control`, decoded `PAYMENT-REQUIRED` and MPP challenge parameters.

## Differences from the TypeScript SDK

- **Framework**: ASGI (Starlette and FastAPI) instead of web-standard `Request`/`Response`; the
  middleware is the counterpart of `radius-sdk/hono`. WSGI frameworks (Flask, Django without ASGI)
  are not supported, because the x402 Python core's sync server cannot run the SDK's async
  facilitator.
- **Signers**: a private key, an eth-account `LocalAccount`, or any object with `address` and
  `sign_typed_data(domain, types, primary_type, message) -> bytes`. Only a key or `LocalAccount` can
  send transactions (the Permit2 approval, `send`, `approve`). There is no injected browser wallet.
- **Names**: snake_case throughout (`pay_to`, `max_per_request`, `on_settled`). Atomic amounts are
  `int`. Receipts are a `PaymentReceipt` dataclass; `to_dict()` gives the camelCase shape.
- **Request body**: the x402 request adapter does not expose the body (it is async in ASGI); only
  x402 discovery extensions read it.
- **Upstream**: built on the `x402` Python package 2.25.0. The TypeScript SDK uses `@x402/core` and
  `@x402/evm` 2.27.0. The interop tests are the contract between them.
- **MPP**: checked against the TypeScript SDK, which is itself checked against `mppx`, the reference
  implementation; this package is not run against `mppx` directly.

## Development

From `packages/sdk-python` (uses [uv](https://docs.astral.sh/uv/)):

```sh
uv sync --all-extras                      # .venv with every extra and the dev tools
uv run ruff check . && uv run ruff format --check .
uv run mypy
uv run pytest                             # unit tests, plus interop when ../sdk/dist exists
uv run pytest -m interop                  # only the cross-language tests (needs Node and `pnpm build`)
```

| Path | What |
| --- | --- |
| `src/radius_sdk/` | `networks`, `amounts`, `receipt`, `env`, `errors`, `schemes`, `mpp` (wire format), `rpc`, `balances`, `erc20`, `permit2`, `settlement`, `eip712`; `server/` (handler, resource server, facilitator, scheme, MPP payments, proxy); `starlette` (ASGI middleware); `client/` (buyer) |
| `examples/` | `starlette_seller.py`, `fastapi_seller.py` (middleware and validate-then-pay), `proxy_seller.py`, `buy.py` |
| `tests/` | ports of the TypeScript suites (`test_client_parity.py` pins the wire format; the facilitator is mocked and every signature is recovered); `test_interop.py` and `tests/interop/*.mjs` run the TypeScript SDK against this one |
