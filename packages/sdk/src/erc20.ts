/**
 * Common ERC-20 interactions as viem actions: metadata, allowance, approve, transfer,
 * transferFrom, and Transfer-event queries. On the preset networks the default token is the
 * network's payment asset (SBC on Radius, USDC on Base); on any other chain pass `token`, or
 * `erc20Actions({ network })`.
 *
 * Reads take any viem `Client`; writes take a viem WalletClient (a client with an `account`)
 * and, like `createRadiusFetch().send()`, wait for the receipt: Radius finality is sub-second,
 * so the receipt is the natural unit of work. `erc20Actions()` is a client extension:
 *
 *   const wallet = createWalletClient({ account, chain: radiusTestnet.chain, transport: http() }).extend(erc20Actions());
 *   await wallet.transfer({ to, amount: '1.50' });                    // 1.50 SBC (display units, token decimals)
 *   await wallet.approve({ spender, amount: 2_000_000n });           // atomic units
 *   await wallet.getAllowance({ owner: wallet.account.address, spender });
 *
 * Amounts are either `bigint` atomic units or a decimal string in display units, parsed with
 * the token's `decimals` (fetched on-chain when the token is given as a bare address).
 *
 * Transfer events. Radius block numbers are unix milliseconds and a node answers `eth_getLogs`
 * only for spans of at most `MAX_LOG_RANGE` (1e6 blocks, about 16.7 minutes), so `getTransfers`
 * defaults to that window before `toBlock` and fetches wider ranges in sequential chunks.
 * `watchTransfers` is the SDK's own poller (the node has no `eth_newFilter`): ordered within each queried chunk,
 * replayable delivery from a resumable `fromBlock`, with `onCheckpoint` after every fully
 * delivered range. Dedupe on chain ID plus `transferKey(t)` when resuming; checkpoints are not completeness watermarks.
 */

import { erc20Abi, formatUnits, getAddress, parseUnits, type Account, type Address, type Chain, type Client, type Hex, type Transport } from 'viem';
import { getBlockNumber, getLogs, readContract, waitForTransactionReceipt, writeContract } from 'viem/actions';
import type { BalanceClient, BalanceToken } from './balances.js';
import { RadiusPaymentError } from './errors.js';
import { presetForChainId, radiusMainnet, radiusTestnet, resolveNetwork, type NetworkInput } from './networks.js';

/** A viem client that can send transactions: `createWalletClient({ account, chain, transport })`. */
export type TokenWalletClient = Client<Transport, Chain | undefined, Account | undefined>;

/** A token by address, or with its decimals/symbol known up front (saves the `decimals()` read). */
export type TokenInput = Address | BalanceToken;

/** `bigint` = atomic units; `string` = display units (e.g. "1.5"), parsed with the token's decimals. */
export type TokenAmount = bigint | string;

export interface TokenMetadata {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
}

export interface TxResult {
  hash: `0x${string}`;
  /** `pending`: sent but not waited for (`wait: false`); `success` / `reverted`: from the receipt. */
  status: 'pending' | 'success' | 'reverted';
  explorerUrl?: string;
}

export interface WaitOption {
  /** `false`: return `{ status: 'pending' }` right after sending instead of waiting for the receipt. Default: wait. */
  wait?: boolean;
}

export interface TokenTransfer {
  token: Address;
  from: Address;
  to: Address;
  /** Atomic units. */
  amount: bigint;
  transactionHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface GetTokenMetadataParameters {
  token?: TokenInput;
}

export interface GetAllowanceParameters {
  token?: TokenInput;
  owner: Address;
  spender: Address;
}

export interface ApproveParameters extends WaitOption {
  token?: TokenInput;
  spender: Address;
  amount: TokenAmount;
  /** Gas limit for the transaction; skips viem's `eth_estimateGas` when given. */
  gas?: bigint;
}

export interface TransferParameters extends WaitOption {
  token?: TokenInput;
  to: Address;
  amount: TokenAmount;
  /** Gas limit for the transaction; skips viem's `eth_estimateGas` when given. */
  gas?: bigint;
}

export interface TransferFromParameters extends WaitOption {
  token?: TokenInput;
  from: Address;
  to: Address;
  amount: TokenAmount;
  /** Gas limit for the transaction; skips viem's `eth_estimateGas` when given. */
  gas?: bigint;
}

/** Widest `toBlock - fromBlock` a Radius node accepts for `eth_getLogs` (error -33002 beyond). Blocks are unix ms: 1e6 ≈ 16.7 min. */
export const MAX_LOG_RANGE = 1_000_000n;
/** Most `eth_getLogs` calls one `getTransfers` makes before refusing (≈ 11.5 days at MAX_LOG_RANGE); page wider ranges yourself. */
export const MAX_LOG_CHUNKS = 1_000;

export interface GetTransfersParameters {
  token?: TokenInput;
  /** Filter by sender (indexed). */
  from?: Address;
  /** Filter by recipient (indexed). */
  to?: Address;
  /** First block, inclusive. Default: `toBlock - MAX_LOG_RANGE` (clamped at 0). */
  fromBlock?: bigint;
  /** Last block, inclusive. Default: the current head. */
  toBlock?: bigint;
  /** Span per `eth_getLogs` call (default `MAX_LOG_RANGE`); wider ranges are fetched in sequential chunks. */
  maxBlockRange?: bigint;
}

export interface WatchTransfersParameters {
  token?: TokenInput;
  from?: Address;
  to?: Address;
  /**
   * First block to deliver, inclusive. Default: the head at the first poll plus one, i.e. new
   * transfers only. To resume, pass the last checkpoint + 1n: everything from there is delivered
   * again, so dedupe on chain ID plus `transferKey`. Resume earlier to replay potentially late logs.
   */
  fromBlock?: bigint;
  /** Called for each transfer in (blockNumber, logIndex) order and awaited, so a slow handler slows polling rather than reordering. */
  onTransfer: (transfer: TokenTransfer) => void | Promise<void>;
  /** Awaited after delivery, before advancing. Persist this inclusive scan cursor durably; it is not proof of completeness. Rejection retries the chunk. */
  onCheckpoint?: (blockNumber: bigint) => void | Promise<void>;
  /** Query behind the head by this many block-number units. Default: 5000 on Radius (5 seconds), 0 elsewhere. Must be nonnegative. */
  blockLag?: bigint;
  /** Poll and delivery failures (including a throwing `onTransfer`). The range is retried on the next poll; nothing is skipped. */
  onError?: (error: Error) => void;
  /** Milliseconds between polls (default: the client's `pollingInterval`). Blocks are ms on Radius, so this is only latency. */
  pollingInterval?: number;
  /** Span per `eth_getLogs` call (default `MAX_LOG_RANGE`). */
  maxBlockRange?: bigint;
}

function addressOf(token: TokenInput): Address {
  return typeof token === 'string' ? token : token.address;
}

/**
 * The token an action works on: the argument, else the payment asset of the client's chain when
 * that chain is a preset (SBC on Radius, USDC on Base). Any other chain has no default: a custom network's asset
 * is not visible from `client.chain`, and silently using SBC's address would send `approve` /
 * `transfer` to the wrong contract. `what` names the action for the error message.
 */
export function resolveToken(client: BalanceClient, token: TokenInput | undefined, what: string): TokenInput {
  if (token) return token;
  const preset = presetForChainId(client.chain?.id);
  if (preset) return preset.asset;
  const chain = client.chain ? `chain ${client.chain.id}` : 'a client with no chain';
  throw new RadiusPaymentError('config', `${what}: no token given and ${chain} is not a preset network, so there is no default token. Pass { token }, or extend the client with erc20Actions({ network }) or erc20Actions({ token: network.asset }).`);
}

/**
 * Default token from an actions config: `token`, else `network`'s payment asset (after checking
 * that `network` is the chain the client is on). `undefined` leaves the per-call resolution to
 * `resolveToken`.
 */
export function configuredToken(client: BalanceClient, config: { token?: TokenInput; network?: NetworkInput }, what: string): TokenInput | undefined {
  if (config.token) return config.token;
  if (config.network === undefined) return undefined;
  const net = resolveNetwork(config.network);
  if (client.chain && client.chain.id !== net.chainId) {
    throw new RadiusPaymentError('config', `${what}: network ${net.name} is chain ${net.chainId} but the client is on chain ${client.chain.id}`);
  }
  return net.asset;
}

async function decimalsOf(client: BalanceClient, token: TokenInput): Promise<number> {
  if (typeof token !== 'string') return token.decimals;
  return readContract(client, { address: token, abi: erc20Abi, functionName: 'decimals' });
}

/** Convert a `TokenAmount` to atomic units, reading `decimals()` only when needed. */
export async function toTokenAtomic(client: BalanceClient, token: TokenInput, amount: TokenAmount): Promise<bigint> {
  if (typeof amount === 'bigint') {
    if (amount < 0n) throw new RadiusPaymentError('config', `Token amount must not be negative (got ${amount})`);
    return amount;
  }
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new RadiusPaymentError('config', `Token amount must be a decimal string like "1.5" or a bigint of atomic units (got ${JSON.stringify(amount)})`);
  const decimals = await decimalsOf(client, token);
  const frac = s.split('.')[1] ?? '';
  if (frac.length > decimals) throw new RadiusPaymentError('config', `Token amount ${s} has more than ${decimals} decimal places`);
  return parseUnits(s, decimals);
}

/** `name`, `symbol`, `decimals` and `totalSupply` of a token, read in parallel. */
export async function getTokenMetadata(client: BalanceClient, args: GetTokenMetadataParameters = {}): Promise<TokenMetadata> {
  const address = addressOf(resolveToken(client, args.token, 'getTokenMetadata'));
  const read = <F extends 'name' | 'symbol' | 'decimals' | 'totalSupply'>(functionName: F) =>
    readContract(client, { address, abi: erc20Abi, functionName }) as Promise<F extends 'decimals' ? number : F extends 'totalSupply' ? bigint : string>;
  const [name, symbol, decimals, totalSupply] = await Promise.all([read('name'), read('symbol'), read('decimals'), read('totalSupply')]);
  return { address, name, symbol, decimals, totalSupply };
}

/** ERC-20 `allowance(owner, spender)`, in atomic units. */
export async function getAllowance(client: BalanceClient, args: GetAllowanceParameters): Promise<bigint> {
  const address = addressOf(resolveToken(client, args.token, 'getAllowance'));
  return await readContract(client, { address, abi: erc20Abi, functionName: 'allowance', args: [args.owner, args.spender] });
}

/** Require an account on the client, else a `config` error naming the action. */
export function requireAccount(client: TokenWalletClient, what: string): Account {
  if (!client.account) {
    throw new RadiusPaymentError('config', `${what} needs a wallet client with an account: createWalletClient({ account, chain, transport })`);
  }
  return client.account;
}

/** Explorer link for a transaction on the client's chain, when it declares an explorer. */
export function explorerUrlFor(client: Client<Transport, Chain | undefined>, hash: Hex): string | undefined {
  const base = client.chain?.blockExplorers?.default.url;
  return base ? `${base.replace(/\/+$/, '')}/tx/${hash}` : undefined;
}

/**
 * Send a transaction through `send`, then wait for its receipt. With `wait: false` the result is
 * `{ status: 'pending' }`: nothing is known about the outcome yet, so never read it as success.
 */
export async function sendAndWait(client: TokenWalletClient, wait: boolean | undefined, send: () => Promise<Hex>): Promise<TxResult> {
  const hash = await send();
  const explorerUrl = explorerUrlFor(client, hash);
  if (wait === false) return { hash, status: 'pending', explorerUrl };
  const receipt = await waitForTransactionReceipt(client, { hash });
  return { hash, status: receipt.status === 'success' ? 'success' : 'reverted', explorerUrl };
}

/** ERC-20 `approve(spender, amount)` from the client's account. */
export async function approve(client: TokenWalletClient, args: ApproveParameters): Promise<TxResult> {
  const account = requireAccount(client, 'approve');
  const token = resolveToken(client, args.token, 'approve');
  const amount = await toTokenAtomic(client, token, args.amount);
  return sendAndWait(client, args.wait, () =>
    writeContract(client, { address: addressOf(token), abi: erc20Abi, functionName: 'approve', args: [args.spender, amount], account, chain: client.chain, gas: args.gas }),
  );
}

/** ERC-20 `transfer(to, amount)` from the client's account. */
export async function transfer(client: TokenWalletClient, args: TransferParameters): Promise<TxResult> {
  const account = requireAccount(client, 'transfer');
  const token = resolveToken(client, args.token, 'transfer');
  const amount = await toTokenAtomic(client, token, args.amount);
  return sendAndWait(client, args.wait, () =>
    writeContract(client, { address: addressOf(token), abi: erc20Abi, functionName: 'transfer', args: [args.to, amount], account, chain: client.chain, gas: args.gas }),
  );
}

/** ERC-20 `transferFrom(from, to, amount)`: spend an allowance `from` granted to the client's account. */
export async function transferFrom(client: TokenWalletClient, args: TransferFromParameters): Promise<TxResult> {
  const account = requireAccount(client, 'transferFrom');
  const token = resolveToken(client, args.token, 'transferFrom');
  const amount = await toTokenAtomic(client, token, args.amount);
  return sendAndWait(client, args.wait, () =>
    writeContract(client, { address: addressOf(token), abi: erc20Abi, functionName: 'transferFrom', args: [args.from, args.to, amount], account, chain: client.chain, gas: args.gas }),
  );
}

type TransferLog = { address: Address; args: { from?: Address; to?: Address; value?: bigint }; transactionHash: Hex | null; blockNumber: bigint | null; logIndex: number | null };

const TRANSFER_EVENT = erc20Abi.find((i) => i.type === 'event' && i.name === 'Transfer')!;

function toTransfer(log: TransferLog): TokenTransfer {
  return {
    token: getAddress(log.address), // nodes return it lowercase; `from` / `to` are checksummed by the decoder
    from: log.args.from as Address,
    to: log.args.to as Address,
    amount: log.args.value as bigint,
    transactionHash: log.transactionHash as Hex,
    blockNumber: log.blockNumber as bigint,
    logIndex: log.logIndex as number,
  };
}

/** Stable identity within one chain: `transactionHash:logIndex`. Prefix with chain ID in multi-chain stores. */
export function transferKey(t: Pick<TokenTransfer, 'transactionHash' | 'logIndex'>): string {
  return `${t.transactionHash}:${t.logIndex}`;
}

const byPosition = (a: TokenTransfer, b: TokenTransfer): number =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1;

interface ChunkArgs {
  from?: Address;
  to?: Address;
  fromBlock: bigint;
  toBlock: bigint;
  maxBlockRange?: bigint;
}

/** Sequential `eth_getLogs` calls of at most `maxBlockRange` blocks each, ascending; each chunk sorted by (blockNumber, logIndex). */
async function* transferChunks(client: BalanceClient, address: Address, args: ChunkArgs): AsyncGenerator<{ fromBlock: bigint; toBlock: bigint; transfers: TokenTransfer[] }> {
  const range = args.maxBlockRange ?? MAX_LOG_RANGE;
  if (range <= 0n) throw new RadiusPaymentError('config', `maxBlockRange must be positive (got ${range})`);
  if (args.fromBlock < 0n || args.fromBlock > args.toBlock) throw new RadiusPaymentError('config', `Block range ${args.fromBlock}..${args.toBlock} is empty or negative`);
  for (let start = args.fromBlock; start <= args.toBlock; ) {
    const end = start + range < args.toBlock ? start + range : args.toBlock; // end - start <= range, which the node accepts
    const logs = await getLogs(client, {
      address,
      event: TRANSFER_EVENT,
      args: { from: args.from, to: args.to },
      fromBlock: start,
      toBlock: end,
      strict: true,
    } as Parameters<typeof getLogs>[1]);
    yield { fromBlock: start, toBlock: end, transfers: (logs as unknown as TransferLog[]).map(toTransfer).sort(byPosition) };
    start = end + 1n;
  }
}

/**
 * Past `Transfer` events of a token, filtered by `from` / `to`, in (blockNumber, logIndex) order.
 * Defaults to the last `MAX_LOG_RANGE` blocks before `toBlock` (the head unless given); a wider
 * `fromBlock..toBlock` is fetched in sequential chunks, up to `MAX_LOG_CHUNKS` calls.
 */
export async function getTransfers(client: BalanceClient, args: GetTransfersParameters = {}): Promise<TokenTransfer[]> {
  const address = addressOf(resolveToken(client, args.token, 'getTransfers'));
  const toBlock = args.toBlock ?? (await getBlockNumber(client, { cacheTime: 0 }));
  const fromBlock = args.fromBlock ?? (toBlock > MAX_LOG_RANGE ? toBlock - MAX_LOG_RANGE : 0n);
  const range = args.maxBlockRange ?? MAX_LOG_RANGE;
  if (range > 0n && fromBlock <= toBlock) {
    const chunks = (toBlock - fromBlock) / (range + 1n) + 1n;
    if (chunks > BigInt(MAX_LOG_CHUNKS)) {
      throw new RadiusPaymentError('config', `getTransfers: ${fromBlock}..${toBlock} spans ${toBlock - fromBlock} blocks, ${chunks} eth_getLogs calls of ${range} (max ${MAX_LOG_CHUNKS}); narrow the range or page it yourself`);
    }
  }
  const out: TokenTransfer[] = [];
  for await (const chunk of transferChunks(client, address, { from: args.from, to: args.to, fromBlock, toBlock, maxBlockRange: args.maxBlockRange })) out.push(...chunk.transfers);
  return out;
}

/**
 * Poll sequential ranges, awaiting delivery and durable checkpoint acknowledgement before
 * advancing. Failed chunks replay. Radius queries lag the head by 5 seconds for receipt/log
 * visibility; this is not a completeness guarantee. Re-scan older ranges with getTransfers
 * and deduplicate by chain ID, transaction hash and log index to reconcile late arrivals.
 * Ordering is per chunk, not a global execution order. Returns a stop function; in-flight
 * callbacks cannot be cancelled.
 */
export function watchTransfers(client: BalanceClient, args: WatchTransfersParameters): () => void {
  const address = addressOf(resolveToken(client, args.token, 'watchTransfers'));
  const interval = args.pollingInterval ?? client.pollingInterval;
  const isRadius = client.chain?.id === radiusMainnet.chainId || client.chain?.id === radiusTestnet.chainId;
  const lag = args.blockLag ?? (isRadius ? 5_000n : 0n);
  if (lag < 0n) throw new RadiusPaymentError('config', 'blockLag must be nonnegative');
  let next = args.fromBlock; // undefined until the first head is seen
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    try {
      const head = await getBlockNumber(client, { cacheTime: 0 });
      if (next === undefined) next = head + 1n;
      const upper = head - lag;
      if (upper >= next) {
        for await (const chunk of transferChunks(client, address, { from: args.from, to: args.to, fromBlock: next, toBlock: upper, maxBlockRange: args.maxBlockRange })) {
          for (const t of chunk.transfers) {
            if (!active) return;
            await args.onTransfer(t);
          }
          if (!active) return;
          await args.onCheckpoint?.(chunk.toBlock);
          if (!active) return;
          next = chunk.toBlock + 1n; // only after delivery and checkpoint acknowledgement
        }
      }
    } catch (e) {
      if (active) args.onError?.(e as Error); // `next` untouched: retried next poll
    }
    if (active) timer = setTimeout(tick, interval);
  };
  void tick();
  return () => {
    active = false;
    if (timer) clearTimeout(timer);
  };
}

/** Display helper: atomic → "1.5 SBC" for a known token. */
export function formatTokenAmount(atomic: bigint, token: BalanceToken): string {
  return `${formatUnits(atomic, token.decimals)} ${token.symbol}`;
}

// A type alias, not an interface: viem's `client.extend()` needs the implicit index signature.
export type Erc20Actions = {
  getTokenMetadata: (args?: GetTokenMetadataParameters) => Promise<TokenMetadata>;
  getAllowance: (args: GetAllowanceParameters) => Promise<bigint>;
  approve: (args: ApproveParameters) => Promise<TxResult>;
  transfer: (args: TransferParameters) => Promise<TxResult>;
  transferFrom: (args: TransferFromParameters) => Promise<TxResult>;
  getTransfers: (args?: GetTransfersParameters) => Promise<TokenTransfer[]>;
  watchTransfers: (args: WatchTransfersParameters) => () => void;
};

export interface Erc20ActionsConfig {
  /** Default token for every action. */
  token?: TokenInput;
  /**
   * Default token = this network's payment asset (like `radiusActions({ network })`); it must be
   * the chain the client is on. Without `token` or `network`, only the preset networks have a
   * default; any other chain throws a `config` error until one is given.
   */
  network?: NetworkInput;
}

/**
 * viem client extension for ERC-20 interactions. Reads work on any client; `approve`,
 * `transfer` and `transferFrom` need a wallet client with an account.
 */
export function erc20Actions(config: Erc20ActionsConfig = {}) {
  return (client: TokenWalletClient): Erc20Actions => {
    const fallback = configuredToken(client, config, 'erc20Actions');
    const withToken = <T extends { token?: TokenInput }>(args: T): T => ({ ...args, token: args.token ?? fallback });
    return {
      getTokenMetadata: (args = {}) => getTokenMetadata(client, withToken(args)),
      getAllowance: (args) => getAllowance(client, withToken(args)),
      approve: (args) => approve(client, withToken(args)),
      transfer: (args) => transfer(client, withToken(args)),
      transferFrom: (args) => transferFrom(client, withToken(args)),
      getTransfers: (args = {}) => getTransfers(client, withToken(args)),
      watchTransfers: (args) => watchTransfers(client, withToken(args)),
    };
  };
}
