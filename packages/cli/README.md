# radius-cli

A CLI wallet for the [Radius Network](https://radiustech.xyz) — modeled on Foundry's `cast`, with a built-in account stored in `~/.radius/keystore.json`.

```bash
npx radius-cli wallet new
npx radius-cli wallet address
npx radius-cli wallet balance
npx radius-cli wallet send 0xRecipient 0.10 RUSD
npx radius-cli call 0xToken "balanceOf(address)(uint256)" 0xUser
```

## Install

```bash
# One-off invocation
npx radius-cli <command>

# Or install globally — the binary on $PATH is `radius-cli`
npm install -g radius-cli
radius-cli wallet address
```

Requires Node ≥ 22.

## Networks

| Network | Chain ID | Default RPC |
|---|---|---|
| `mainnet` *(default)* | 723487 | `https://rpc.radiustech.xyz` |
| `testnet` | 72344 | `https://rpc.testnet.radiustech.xyz` |

Override the URL with `--rpc-url` or `RADIUS_RPC_URL` if you want to point at a different endpoint.

## Wallet

On first use, any account-needing command (`wallet address`, `balance`, `sign`, `send`, …) auto-creates a keystore at `~/.radius/keystore.json` with no password set (file mode `0o600`). No command prompts while creating it, so agents and scripts never block. To add a password later and keep the same key and address, run `radius-cli wallet password` (set `RADIUS_NEW_PASSWORD` to skip the prompt); to set one at creation, set `RADIUS_PASSWORD` before the first command. (`wallet new --force` replaces the key with a new one.) The keystore is Web3 Secret Storage v3 — compatible with geth/foundry. The address is cached in `~/.radius/config.json` so `radius-cli wallet address` is a cheap read.

```bash
radius-cli wallet new
radius-cli wallet import 0xPRIVATE_KEY
radius-cli wallet address
radius-cli wallet balance [0xAddr]
radius-cli wallet export                           # decrypts and prints the private key
radius-cli wallet password                         # set or change the keystore password, same address
radius-cli --network testnet wallet faucet         # request a faucet drip (testnet ~0.5 SBC; mainnet ~0.01 SBC/day)
radius-cli wallet sign "hello"                     # EIP-191 personal_sign — prints 0x signature
radius-cli wallet sign --raw 0xdeadbeef            # sign raw hex bytes
echo -n "msg" | radius-cli wallet sign -           # read message from stdin
radius-cli wallet sign-typed-data '{"domain":…,"types":…,"primaryType":…,"message":…}'   # EIP-712 — prints 0x signature (or '-' for stdin)
radius-cli wallet sign-jwt --claims '{"aud":"my-service"}' --expires-in 600       # ES256K JWT; iss defaults to the address
radius-cli wallet verify "hello" 0xSig             # verify against own address
radius-cli wallet verify "hello" 0xSig --address 0xOther
radius-cli wallet send 0xTo 0.10 RUSD              # native value transfer
radius-cli wallet send 0xTo 0.10 SBC               # ERC-20 transfer of SBC
radius-cli wallet send 0xTo 0.10 0xToken           # ERC-20 transfer of any token (decimals read on-chain)
radius-cli wallet send 0xToken "transfer(address,uint256)" 0xTo 100   # arbitrary call
```

`wallet send` takes the token as its last argument: `RUSD` for a native transfer, `SBC`, or any ERC-20 contract address. Amounts are in display units (`1.5` means 1.5 tokens) and are parsed with the token's decimals — known for SBC, read on-chain for other tokens. ERC-20 sends and `wallet balance` run on the actions of [`radius-sdk/client`](../sdk) (`erc20Actions`, `radiusActions`), so a script and the CLI encode the same calls.

`wallet balance` prints one line per asset and the total, so each one greps on its own (`radius-cli wallet balance | grep '^SBC:'`):

```text
Address: 0x4F2D8a3b1c0E5d9b8e7a6c5d4e3f2a1b0c9d8e7f
SBC:     10.000000
RUSD:    2.345678
Total:   12.345678 USD
```

`--private-key 0xHEX` overrides the keystore on any command.

## HTTP payments: x402 and MPP (`wallet pay`)

Make an HTTP request and, if the server responds with `402 Payment Required` and an x402 or MPP challenge, pay it from the local wallet and retry. The protocol side is handled by [`radius-sdk`](../sdk) (`createRadiusFetch`), the same code applications and agents use; the CLI adds the wallet, prompts and output.

```bash
radius-cli wallet pay get https://example.com/protected
radius-cli wallet pay post https://api.example.com/x -d '{"a":1}' -H 'Authorization: Bearer …'
radius-cli wallet pay get https://example.com/r --threshold 0.05          # auto-pay up to 0.05 of the asset
radius-cli wallet pay get https://example.com/r -y                        # auto-pay any amount
radius-cli wallet pay get https://example.com/r --networks radius,base    # also pay in USDC on Base
radius-cli wallet pay get https://example.com/r --protocol mpp            # pay over MPP only
radius-cli wallet pay get https://example.com/r --json                    # envelope with status/headers/body/payment
```

Verbs: `get`, `post`, `put`, `patch`, `delete`, `head`, `options`.

`-d, --data` accepts a literal string, `-d @path` to read from a file, or `-d -` to read from stdin. JSON-shaped bodies default to `Content-Type: application/json` unless one is set with `-H`.

`--threshold <decimal>` is in the asset's display units (e.g. `0.05` means 0.05 SBC or 0.05 USDC, which is $0.05 since both are USD-pegged). When the offered fee is at or below the threshold, the request pays without prompting — designed for AI agents and other non-interactive use. For the `upto` scheme the threshold is compared against the authorized maximum. Above the threshold the CLI prompts on a TTY and refuses (exit 2) without one; with `--yes` as well it refuses rather than pays, so the threshold stays a hard cap and `--yes` only means "don't ask". With no threshold, `--yes` pays any amount, and with neither flag a non-TTY run refuses (exit 2) rather than hang.

Payments are made on Radius in SBC by default. `--networks radius,base` (or `RADIUS_PAY_NETWORKS`, or `payNetworks` in the config file) adds Base, paying in USDC; the list is a preference order, and `--network testnet` pairs Radius testnet with Base Sepolia. The same key signs on every network. Offers on other networks or in other assets are refused before anything is signed, and the keystore is only unlocked once an offer has been accepted. `--sbc` / `RADIUS_SBC_ADDRESS` relocate the SBC contract (for another deployment of the same token); the CLI still assumes SBC's symbol, 6 decimals and EIP-712 domain behind that address. When a server lists several compatible offers, the first network in your list that your wallet can cover wins (balances are read only when the server accepts more than one of your networks), then the first offer on it in the server's order. Two protocols are spoken: [x402](https://x402.org) and [MPP](https://mpp.dev) (`WWW-Authenticate: Payment` challenges, `evm` charges paid by an EIP-3009 authorization, no approval or gas). With `--protocol auto` (the default) a server offering both is paid over x402; `--protocol x402` or `--protocol mpp` restricts it to one. The JSON `payment` object says which (`protocol`). A request that sets its own `Authorization` header is not paid over MPP, whose credential goes in that header. Both x402 v1 and v2 are supported, selected automatically from the server's advertised `x402Version`:

- **`exact`** — a fixed price. v1 and v2 support EIP-3009 `transferWithAuthorization`; v2 also supports any ERC-20 advertised with `assetTransferMethod: "permit2"`, signing a Uniswap Permit2 `permitWitnessTransferFrom` authorization through `x402ExactPermit2Proxy`.
- **`upto`** (v2, Uniswap Permit2 `permitWitnessTransferFrom` via the `x402UptoPermit2Proxy`) — the client signs a Permit2 authorization up to a maximum and the facilitator settles the actual usage (which may be less, or zero).

Permit2 payments need an ERC-20 approval for the canonical Permit2 contract. When the server declares `eip2612GasSponsoring` (the Radius facilitator does), the CLI signs an EIP-2612 permit alongside the payment and no on-chain approval transaction is ever sent — a wallet holding only SBC can pay. A facilitator that instead sponsors a raw unlimited approve (`erc20ApprovalGasSponsoring`) goes through the same prompt as an unsponsored approval. For either, pass `--approve-permit2` (or `-y`) to allow it automatically (unsponsored: a one-time unlimited approval, gas in SBC on Radius, ETH on Base); without it the CLI prompts (or refuses with no TTY). `--approve-permit2` grants the approval whenever the allowance is short, even when the payment is sponsored, which is the way out when a facilitator answers 412. Each payment is still individually authorized by a signed Permit2 message capped to that payment's amount.

Redirects are followed by `fetch` (its limit of 20). A request whose 402 comes after a redirect is paid at the final URL, not at the redirector, repeating your verb and body there (after a `301`/`302`/`303` the final URL saw a `GET` for a `POST`). A redirect after payment is followed without the payment header, and the receipt is read from the redirect's `PAYMENT-RESPONSE`.

Body goes to stdout; payment confirmation and (optionally, with `--include`) headers go to stderr — pipeable.

## Check a seller (`sell check`)

Check your own paid endpoint before buyers see it. `sell check` requests the URL without paying and audits the `402` with [`radius-sdk`](../sdk): the x402 `PAYMENT-REQUIRED` challenge (decoded with `@x402/core`, as the SDK does) and any MPP `WWW-Authenticate: Payment` challenge. Like the SDK buyer, it also reads an x402 challenge from a JSON body when there is no `PAYMENT-REQUIRED` header (v1 sellers); a malformed offer is reported as a failed check, not a crash.

```bash
radius-cli sell check http://127.0.0.1:3000/api/report
radius-cli sell check http://127.0.0.1:3000/api/report --price '$0.001' --probe-head
radius-cli sell check https://api.example.com/query -X post -d '{"q":1}' --facilitator https://facilitator.example
radius-cli --json sell check http://127.0.0.1:3000/api/report          # one JSON report on stdout
RADIUS_HOME=.radius radius-cli sell check https://api.example.com/r --pay --threshold 0.01
```

For each x402 offer it checks that the network is a known preset, the asset is that network's payment asset (or `--sbc` on Radius) with the matching EIP-712 domain, the amount is an atomic integer (equal to `--price` converted with the asset's decimals, which catches 18-decimal mistakes; without `--price`, a price above 1000 per request is a warning), `payTo` is a non-zero address, `resource.url` is the requested URL, and `maxTimeoutSeconds` is a sensible positive integer. It then reads the facilitator's `/supported` (the network's default facilitator, or every `--facilitator <url>` given, with `RADIUS_FACILITATOR_API_KEY` sent as `x-api-key`) and checks that it lists each offer's scheme, network and transfer method. MPP challenges are checked for network, currency, decimals, amount, recipient and expiry, and whether they mirror an x402 offer; a seller without MPP is reported as `info`. Finally it asks the SDK buyer (`createRadiusFetch`, with a throwaway key that never signs) whether it would select the offer.

- `-X, --method <verb>`, `-H`, `-d`: the request, as for `wallet pay` (default `GET`).
- `--probe-head`: also send an unpaid `HEAD` and warn when it answers `2xx` (routers serve `HEAD` with the `GET` handler, which x402 routes keyed `GET` do not charge).
- `--pay --threshold <decimal>`: when every check passed, make one paid request from the local wallet (`RADIUS_HOME` applies) and check that a receipt comes back. It pays on testnet unless `--network mainnet` is passed explicitly; `RADIUS_NETWORK` and the config file do not switch it to mainnet. `--networks` works as for `wallet pay`.
- `--timeout <ms>`: per request, default 15000. The paid request of `--pay` gets four times that (at least 60 s), since the seller settles before it answers; if it still fails after the payment was sent, the message says the payment may have settled.

Each check prints as `ok`, `warn`, `FAIL`, `skip` or `info`. Exit code `0` means no check failed (warnings allowed), `1` that one did, `2` invalid flags (a malformed `-H`, an unreadable `-d @file`, an unknown `--network`/`--networks`, a bad `--price` or `--threshold`).

## Read commands

```bash
radius-cli call 0xToken "balanceOf(address)(uint256)" 0xUser   # decoded result
radius-cli tx 0xTransactionHash
radius-cli receipt 0xTransactionHash
radius-cli receipt 0xTransactionHash --event "Transfer(address indexed from, address indexed to, uint256 value)"
radius-cli storage 0xContract 0
radius-cli code 0xContract
radius-cli nonce 0xAddress
radius-cli --network testnet network              # chain id, RPC, explorer, faucet, facilitator, SBC (offline)
```

Function signatures use `cast` syntax: `name(args)` for state-changing calls, `name(args)(returns)` for read calls (the result is decoded against the return types).

`receipt --event <sig>` decodes the receipt's logs against a `cast`-style event signature. Repeat `--event` to try several signatures against every log. A log is decoded when its `topics[0]` is the event's selector and its topic count matches the number of `indexed` params, so mark them with `indexed`: that is how the decoder tells topics from data, and how it tells an ERC-20 `Transfer` (two indexed params) from an ERC-721 `Transfer` (three). A log whose selector matches but whose topic count does not is left undecoded, with a warning on stderr. Logs that match no signature are printed raw, never dropped. Unnamed params are keyed by position (`"0"`, `"1"`, …).

```bash
radius-cli --json receipt 0xTx --event "Transfer(address indexed,address indexed,uint256 indexed tokenId)" \
  | jq -r 'map(select(.eventName == "Transfer"))[0].args.tokenId'
```

## JSON output

Pass `--json` to any command to emit machine-readable JSON on stdout (one object per command, pretty-printed). Useful for piping into `jq` or driving the CLI from scripts and agents. Bigints are serialized as decimal strings.

```bash
$ radius-cli --json wallet address
{
  "address": "0x4F2D8a3b1c0E5d9b8e7a6c5d4e3f2a1b0c9d8e7f"
}

$ radius-cli --json wallet balance 0x4F2D8a3b1c0E5d9b8e7a6c5d4e3f2a1b0c9d8e7f
{
  "address": "0x4F2D8a3b1c0E5d9b8e7a6c5d4e3f2a1b0c9d8e7f",
  "totalUsd": 12.345678,
  "sbc": "10",
  "rusd": "2.345678",
  "sbcWei": "10000000",
  "rusdWei": "2345678000000000000",
  "aggregateWei": "12345678000000000000",
  "rusdSource": "evm",
  "sbcError": null
}

$ radius-cli --json wallet send 0xRecipient 0.10 RUSD | jq -r .hash
0xabc…

$ radius-cli --json call 0xToken "balanceOf(address)(uint256)" 0xUser
"42000000"

$ radius-cli --json nonce 0xAddress
{
  "address": "0xAddress",
  "nonce": 17
}
```

Per-command JSON shapes:

| Command | JSON shape |
|---|---|
| `wallet new` / `wallet import` | `{path, address}` |
| `wallet password` | `{path, address, passwordless}` |
| `wallet address` | `{address}` |
| `wallet export` | `{address, privateKey}` |
| `wallet sign-jwt` | `{address, token}` |
| `wallet sign` | `{address, signature}` |
| `wallet faucet` | `{address, network, amount, txHash, explorerUrl}` |
| `wallet verify` | `{address, valid}` (exit 1 when invalid) |
| `wallet balance` | `{address, totalUsd, sbc, rusd, sbcWei, rusdWei, aggregateWei, rusdSource, sbcError}` |
| `wallet send` | `{hash, receipt?}` (no `receipt` with `--no-wait`) |
| `wallet pay` | `{status, headers, body, bodyEncoding, payment}` (`payment.network` is the CAIP-2 network paid on) |
| `sell check` | `{url, method, ok, status, x402Version, resource, offers, mpp, facilitators, payment?, checks: [{id, status, message}], summary}` (exit 1 when `ok` is false) |
| `call` | decoded return value (single value or array) |
| `tx` | the full transaction object |
| `receipt` | the full receipt object |
| `receipt --event` | array of logs: `{address, logIndex, eventName, args}` when decoded, `{address, logIndex, topics, data}` when not |
| `code` | `{address, code}` |
| `nonce` | `{address, nonce}` |
| `network` | `{name, chainId, caip2, testnet, rpcUrl, explorerUrl, faucetUrl, facilitatorUrl, nativeCurrency, asset}` |
| `storage` | `{address, slot, value}` |

Errors continue to go to stderr as `error: <message>` with a non-zero exit code; only successful output is JSON-shaped.

## Configuration

In priority order (highest first):

1. **CLI flag** — `--network`, `--rpc-url`, `--private-key`, `--sbc`, `--rusd`, `--json`
2. **Environment** — `RADIUS_NETWORK`, `RADIUS_RPC_URL`, `RADIUS_SBC_ADDRESS`, `RADIUS_RUSD_ADDRESS`, `RADIUS_PAY_NETWORKS`, `RADIUS_BASE_RPC_URL`, `RADIUS_BASE_SEPOLIA_RPC_URL`, `RADIUS_FACILITATOR_API_KEY` (`sell check`), `RADIUS_PASSWORD`, `RADIUS_NEW_PASSWORD` (`wallet password`), `RADIUS_KEYSTORE_PATH`, `RADIUS_HOME`
3. **`~/.radius/config.json`** — fields: `network`, `rpcUrl`, `sbcAddress`, `rusdAddress`, `payNetworks` (e.g. `["radius", "base"]`), `rpcUrls` (`{ "base": …, "base-sepolia": … }`)
4. **Built-in defaults** — mainnet

SBC defaults to `0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb`, its address on both mainnet and testnet (taken from `radius-sdk`); set `--sbc` / `RADIUS_SBC_ADDRESS` / `sbcAddress` only for another deployment.

## Notes on the Radius network

- **RUSD** is the native gas token (18 decimals). `wallet send … RUSD` is a native value transfer.
- **SBC** is an ERC-20 stablecoin (6 decimals). `wallet send … SBC` calls `transfer(address,uint256)` on the SBC contract.
- `eth_getBalance` on Radius reports native RUSD **plus** SBC valued 1:1. `wallet balance` reads the two apart (`rusd` is native only, `rusdSource` says how) and `totalUsd` is the spendable total, so SBC is never counted twice.
- Radius uses **fixed gas pricing**. All transactions will execute with the network gas price (n.b. they will fail if the requested gas price is too low).
- If the account holds SBC but lacks RUSD, the network's Turnstile auto-converts SBC to RUSD inline for zero additional gas.

## Development

This package lives in the `packages/cli` workspace of the `tools` repository, next to `packages/sdk`.

```bash
pnpm install                     # at the repository root
pnpm --filter radius-cli build   # tsc -b: builds packages/sdk first when its dist is missing or stale
pnpm --filter radius-cli test
node packages/cli/dist/index.js --help
```
