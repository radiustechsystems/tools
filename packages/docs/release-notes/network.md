<!--
Radius Network release notes, written by hand, newest first. scripts/generate-release-notes.ts merges
them with the radius-sdk, radius-cli and Radius skills changelogs into docs/pages/release-notes.mdx.
Start each release with `## <YYYY-MM-DD> (<build>)`; `###` and `####` headings group its changes.
The text is rendered as MDX: escape `{`, `}` and `<` outside code.
-->

## 2026-09-28 (099a1b5b)

### Improvements

- Historical `eth_getLogs` queries are available again, within the existing address-filter and block-range limits. `eth_getBlockByNumber` lookups are faster.
- Reduced overhead for RPC requests.
- Improved reliability when scaling nodes and recovering from failures.

## 2026-09-24 (10eea1f9)

### Improvements

- Improved reliability when scaling nodes.

### API / RPC changes

#### `eth_call` / `eth_estimateGas` — Turnstile simulation behavior

- **Before:** One full Turnstile iteration was always applied during simulation. `balanceOf` in an `eth_call` returned `balance − TURNSTILE_TOKEN_COST` regardless of gas price.
- **After:** If `gas_price × gas_limit + value = 0`, zero iterations run. `balanceOf` in simulation returns the actual, unmodified balance.

**Affected clients:** If your integration calls `eth_call` against a Turnstile-enabled wallet and parses the returned balance by subtracting an expected `TURNSTILE_TOKEN_COST`, update your logic. At zero gas price, no deduction occurs and the full balance is returned. No change is required for integrations running against nodes with a non-zero system gas price.

#### `eth_sendRawTransaction` / `eth_sendRawTransactionSync` — Rejection error messages differentiated

- **Before:** All pending pool rejections returned a single generic error message.
- **After:** Each rejection reason (gas price too low, duplicate nonce, replace-by-fee underpriced, and so on) returns a distinct error message.

**Affected clients:** If your client inspects the error message text to detect and handle specific rejection reasons, update your error parsing to match the new format. Clients that only check for the presence of an error without parsing the message body are unaffected.

## 2026-05-11 (0d56ee4e)

### Improvements

- **Lower Turnstile minimum transaction size**: The minimum amount of SBC required to trigger a Turnstile gas conversion has been reduced tenfold — from 0.10 SBC to 0.01 SBC per execution. Wallets with small token balances can now participate in transactions that previously required a larger deposit. The 10.0 SBC per-transaction ceiling is unchanged.

- **More accurate balance reporting**: `eth_getBalance` now returns your full SBC token holdings converted to native currency, with no artificial ceiling. Previously the reported balance was capped at the per-transaction execution limit; now wallets with larger holdings see their true total displayed in block explorers and wallets. Note that the per-transaction spending limit remains in effect — the displayed balance may exceed what can be spent in a single transaction.

### API / RPC changes

#### `eth_getBalance` — semantics change

- **Before:** Balance was floored to the nearest minimum debit unit and capped at the maximum per-transaction backfill amount.
- **After:** `token_balance × per_unit_exchange_rate + raw_native` — no floor rounding, no cap.

**Affected clients:** Any client that uses `eth_getBalance` to predict whether a transaction will succeed based on comparing the balance to the transaction value. The returned balance may now be higher than what the network will actually provision for a single transaction. Use `eth_estimateGas` to validate that a specific transaction will succeed before submitting.

## 2026-04-23 (1c1556c2)

### Improvements

- Internal stability and reliability improvements.

## 2026-04-15 (7b8a282a)

### Improvements

- `eth_sendRawTransaction` now queues transactions rejected with `NonceTooHigh` in a per-sender pending transaction pool and retries them automatically in a background clearout loop. The pool supports up to 30 queued transactions per sender across up to 100 addresses. Replace-by-fee is supported.
- `eth_sendRawTransactionSync` now returns EIP-7966 error code `6` with the expected nonce on nonce gaps, avoiding an extra `eth_getTransactionCount` round-trip.
- `eth_call` dry-runs now skip balance validation unconditionally.

## 2026-03-30 (b0d6dd06)

### BREAKING CHANGES

- The Mainnet Chain ID has been updated from `723` to `723487`.

### New features

- Method requests referring to old states will now return an error. Radius does not store historical state and such requests succeeding may be misleading. Note: block numbers within the last 1000 seconds will be treated as "current" for tooling compatibility.
- Supports `eth_maxPriorityFeePerGas`.

### Improvements

- Internal Performance Improvements

### Bug Fixes

- Logs in receipts will correctly populate block hash, block number and transaction index.
- Return `null` instead of `0x0` for the `to` field in contract creation transaction receipts.
- Return `null` for invalid block hashes, in requests to `eth_getBlockByHash`.

## 2026-03-26 (89b06f15)

### New features

- Support for `eth_sendRawTransactionSync`
- You can now trigger the turnstile by sending gas tokens directly, rather than just allowin the turnstile to cover gas fees.
  - E.g. `cast send --value 0.1ether ...` will trigger the turnstile if you do not have enough gas tokens to cover the transaction, up to a limit of 10 RUSD.

### Improvements

- Internal Performance Improvements

### Bug fixes

- Fixes a bug where in some cases receipt requests would return the incorrect receipt. This occurred in cases of very high load on transactions involving conflicting state.

### Docs

- Added release notes page
