# Protocols on the seller: x402 v2 and MPP

A radius-sdk seller always speaks x402 v2. MPP is opt-in, alongside it, on `radiusPayments()` (web-standard) and `radius-sdk/hono` only. Both end in the same thing: an authorization of the network's stablecoin, verified and settled by the network's x402 facilitator.

| | x402 v2 | MPP (`evm` charge) |
| --- | --- | --- |
| Unpaid answer | `402` + `PAYMENT-REQUIRED` (base64 JSON, offers in `accepts`) | the same `402` + one `WWW-Authenticate: Payment …` per network |
| Paid request | `PAYMENT-SIGNATURE` (also reads legacy `X-PAYMENT`) | `Authorization: Payment …` |
| Receipt | `PAYMENT-RESPONSE` | `Payment-Receipt` |
| Wrappers | all, including `@x402/express` / `@x402/next` | `radiusPayments()` and `radius-sdk/hono` only |
| Methods | `exact` via EIP-3009 or Permit2 | EIP-3009 authorization |

## x402 v2 `exact`

What the SDK puts in each offer (`accepts[i]`), per network, per route:

- `scheme: 'exact'`. The seller only offers `exact`: no `upto`, no second asset or transfer method on the same network.
- `network`: CAIP-2 (`eip155:72344` testnet, `eip155:723487` mainnet, `eip155:84532` Base Sepolia, `eip155:8453` Base).
- `asset`: the network's payment asset (SBC on Radius, `0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb` on both; USDC on Base), unless `asset` is overridden.
- `amount`: atomic units. A USD price is converted with the asset's decimals (6 for SBC and USDC): `'$0.001'` → `'1000'`.
- `payTo`, `maxTimeoutSeconds` (route option, default 300), and `extra: { assetTransferMethod, name, version }` (the asset's EIP-712 domain: `"Stable Coin"` / `"1"` for SBC).
- Top level: `resource: { url, description, mimeType }` (the URL the request was made to), and `extensions.eip2612GasSponsoring` when declared.

**How the transfer method is chosen.** `RadiusExactScheme` advertises whichever `assetTransferMethod` the facilitator's `/supported` lists **first** for that network and scheme, and `eip3009` when the facilitator names none. The Radius facilitators list `eip3009` then `permit2`, so a Radius seller offers **EIP-3009** (no approval, no gas for the payer). A facilitator that lists `permit2` first gets a Permit2 offer (the buyer needs a Permit2 allowance; see sponsoring below). You do not pick it in code.

**Gas sponsoring.** With `gasSponsoring: 'auto'` (default), `eip2612GasSponsoring` is declared only when the facilitator's `/supported` lists that extension; `true` / `false` force it. It only matters for Permit2 offers: it lets a first-time payer approve Permit2 by signature.

**Facilitator calls.** In the default `settle: 'before'` flow the seller calls `/settle` only (no separate `/verify`). In `settle: 'after'` it calls `/verify`, runs the handler, then `/settle`. See [settlement.md](settlement.md).

## MPP

The SDK implements one MPP method: `method="evm"`, `intent="charge"`, an EIP-3009 authorization settled through the x402 facilitator. It is **not** the Tempo method of `mppx`: a Tempo challenge has `method="tempo"` and a different `request` shape, the SDK seller never emits one, and `createRadiusFetch` and `radius-cli wallet pay` reject it (`no_compatible_offer`). So it is not a drop-in for a server whose MPP rail is Tempo/`mppx`. For that server, Radius is added over x402; MPP stays on Tempo (or `mppx`'s own `evm` method is added next to it).

Enable it with `mpp` on `radiusPayments()` or `radius-sdk/hono`:

```typescript
radiusPayments({
  network: 'testnet',
  payTo: process.env.PAY_TO as `0x${string}`,
  routes: { 'GET /api/report': '$0.001' },
  mpp: { secretKey: process.env.MPP_SECRET_KEY!, realm: 'api.example.com' },   // realm optional
});
```

- `secretKey` must be **at least 32 characters** of random data (`openssl rand -base64 32`); the constructor throws otherwise. Keep it secret and **the same on every instance** serving the same routes: challenges are stateless, and their id is an HMAC of the challenge parameters under this key. A credential issued under another key is refused (`not issued by this server`).
- `realm` defaults to the request's host.
- Each 402 gets one challenge per network that **mirrors an x402 `exact` EIP-3009 offer** (same amount, asset, recipient, network; `expires` = now + `maxTimeoutSeconds`). A network whose offer is Permit2 (facilitator lists `permit2` first) gets no MPP challenge, because the MPP `evm` charge is an EIP-3009 authorization.
- A credential is checked for its HMAC id, realm, expiry, the route's **current** price and recipient, and the nonce bound to the challenge, then verified and settled through the network's facilitator as an x402 `exact` EIP-3009 payment, before or after the handler per `settle`. Tampered amounts or expiries, expired challenges, and replays are refused.
- Paid responses carry `Payment-Receipt`; the handler's `payment` and `onSettled` get a receipt with `protocol: 'mpp'`.
- **Upstream adapters do not serve MPP.** `createRadiusServer({ mpp })` accepts the option, but `@x402/express` and `@x402/next` only see x402: no `WWW-Authenticate` challenge is sent. Use `radiusPayments()` or Hono when MPP matters.

Buyers pick the protocol: `radius-cli wallet pay` and `createRadiusFetch` default to x402 when both are offered (`--protocol mpp` / `protocols: ['mpp']` to prefer MPP).

## Checking what you serve

`radius-cli sell check <url>` decodes both challenges with the SDK and reports each x402 offer and each MPP challenge (amount and decimals, asset, recipient, expiry, and whether the MPP challenge mirrors an x402 offer). A seller without MPP is reported as `info`, not a failure.
