# MPP seller and buyer

A seller that charges `0.001 SBC` per lookup over x402 and [MPP](https://mpp.dev), and a buyer that pays it over MPP (`method="evm"`, `intent="charge"`). Both use `radius-sdk`; the MPP charge is an EIP-3009 authorization of SBC, settled by the same facilitator as x402.

| File | What |
| --- | --- |
| `src/app.ts` | The seller: `radiusPayments({ …, mpp: { secretKey } })` with one paid route |
| `src/seller.ts` | Serves it on Node (port 8791) |
| `src/buyer.ts` | `createRadiusFetch({ protocols: ['mpp'] })` pays a URL and prints the receipt |
| `src/local-facilitator.ts` | A stand-in facilitator that checks the signature but moves nothing on chain |
| `src/demo.ts` | Both sides in one process against the local facilitator, with checks |

Build the SDK first, from the repository root: `pnpm install && pnpm build`.

## Run it without funds

```bash
pnpm --filter radius-mpp-example demo
```

The demo starts the seller with the local facilitator, prints the unpaid `402` with its `PAYMENT-REQUIRED` (x402) and `WWW-Authenticate: Payment` (MPP) headers, then pays from a throwaway key. The buyer signs an EIP-3009 authorization whose nonce is bound to the challenge and retries with `Authorization: Payment …`. The seller verifies and settles it, runs the handler and answers `200` with `Payment-Receipt`. The local facilitator recovers the signer from the signature and returns a made-up transaction hash, so the receipt's explorer link leads nowhere.

The same flow in two terminals:

```bash
MPP_LOCAL_FACILITATOR=1 pnpm --filter radius-mpp-example seller
pnpm --filter radius-mpp-example buy        # no RADIUS_PRIVATE_KEY: a throwaway key
```

## Run it on testnet

Without `MPP_LOCAL_FACILITATOR`, the seller settles through the Radius testnet facilitator, so the buyer needs testnet SBC:

```bash
PAY_TO=0xYourAddress MPP_SECRET_KEY="$(openssl rand -base64 32)" pnpm --filter radius-mpp-example seller
RADIUS_PRIVATE_KEY=0x… pnpm --filter radius-mpp-example buy -- --fund
```

`--fund` first asks the testnet faucet for 0.5 SBC (rate-limited per wallet); leave it off once the wallet holds SBC. Use a testnet-only key. The buyer needs no RUSD and no approval: the facilitator submits the authorization. `MPP_SECRET_KEY` must be at least 32 random characters and the same on every instance that serves the route; without it the seller picks a random key per process.

See [Accept payments](https://docs.radiustech.xyz/build/accept-payments#accept-other-networks-and-mpp), [Make payments](https://docs.radiustech.xyz/build/make-payments#pay-on-other-networks-and-over-mpp) and [MPP in the radius-sdk reference](https://docs.radiustech.xyz/reference/radius-sdk#mpp).
