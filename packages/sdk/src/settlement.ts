import { createPublicClient, http, parseAbiItem, parseEventLogs, type PublicClient, type TransactionReceipt } from 'viem';
import { explorerTxUrl, type Address, type PaymentNetwork } from './networks.js';
import { formatAmount } from './amounts.js';
import type { PaymentReceipt } from './receipt.js';

export interface SettlementTransfer {
  from: Address;
  to: Address;
  /** Atomic units of the network's payment asset. */
  amount: bigint;
}

/** On-chain view of a settlement transaction, for reconciling receipts. */
export interface Settlement {
  transaction: `0x${string}`;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  /** Transfers of the payment asset that happened in this transaction. */
  transfers: SettlementTransfer[];
  /** Total of the payment asset that reached `to` (all transfers if omitted). */
  paid(to?: Address): bigint;
  paidFormatted(to?: Address): string;
  explorerUrl?: string;
}

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

const NOT_FOUND = /not (be )?found|could not be found/i;

function clientFor(network: PaymentNetwork, client?: PublicClient): PublicClient {
  return client ?? createPublicClient({ chain: network.chain, transport: http(network.rpcUrl) });
}

async function readReceipt(pc: PublicClient, txHash: `0x${string}`): Promise<TransactionReceipt | undefined> {
  try {
    return (await pc.getTransactionReceipt({ hash: txHash })) ?? undefined;
  } catch (e) {
    if (e instanceof Error && NOT_FOUND.test(e.message)) return undefined;
    throw e;
  }
}

/** Every ERC-20 `Transfer` in a transaction receipt, with the token that emitted it. */
function tokenTransfers(receipt: TransactionReceipt): (SettlementTransfer & { token: Address })[] {
  return parseEventLogs({ abi: [TRANSFER], logs: receipt.logs, eventName: 'Transfer' }).map((l) => ({
    token: l.address as Address,
    from: l.args.from as Address,
    to: l.args.to as Address,
    amount: l.args.value as bigint,
  }));
}

function toSettlement(network: PaymentNetwork, txHash: `0x${string}`, receipt: TransactionReceipt, asset = network.asset.address): Settlement {
  const token = asset.toLowerCase();
  const transfers = tokenTransfers(receipt)
    .filter((t) => t.token.toLowerCase() === token)
    .map(({ from, to, amount }) => ({ from, to, amount }));
  const paid = (to?: Address) =>
    transfers.filter((t) => !to || t.to.toLowerCase() === to.toLowerCase()).reduce((sum, t) => sum + t.amount, 0n);
  return {
    transaction: txHash,
    status: receipt.status === 'success' ? 'success' : 'reverted',
    blockNumber: receipt.blockNumber,
    transfers,
    paid,
    paidFormatted: (to?: Address) => formatAmount(paid(to), network.asset.decimals, network.asset.symbol),
    explorerUrl: explorerTxUrl(network, txHash),
  };
}

/**
 * Look up a settlement transaction on-chain. Returns undefined while the
 * transaction is unknown to the node (not yet mined, or never existed).
 * Use it to reconcile a timed-out payment before authorising another charge.
 */
export async function getSettlement(network: PaymentNetwork, txHash: `0x${string}`, client?: PublicClient): Promise<Settlement | undefined> {
  const receipt = await readReceipt(clientFor(network, client), txHash);
  return receipt ? toSettlement(network, txHash, receipt) : undefined;
}

/**
 * Outcome of `reconcilePayment`. More values may be added later (for example for pending
 * outcomes); treat a value you do not recognise as not confirmed.
 *
 * - `confirmed`: the chain shows the expected token moving from the payer to the recipient, for an
 *   amount the offer allows (and equal to the reported charge, when one was reported).
 * - `no_charge`: the receipt reports a zero `upto` charge with no transaction; nothing to check on chain.
 * - `mismatch`: the evidence contradicts the offer or the receipt (`reason` says which part).
 * - `reverted`: the settlement transaction reverted; nothing was charged by it.
 * - `unresolved`: the evidence is not available (no transaction named, the node does not know the
 *   transaction yet, or the node could not be read). Not proof of failure: check again later.
 */
export type ReconciliationStatus = 'confirmed' | 'no_charge' | 'mismatch' | 'reverted' | 'unresolved';

/** Why a reconciliation is `mismatch` or `unresolved`. */
export type ReconciliationReason =
  | 'receipt_failed'
  | 'network_mismatch'
  | 'no_transaction'
  | 'malformed_transaction'
  | 'not_found'
  | 'rpc_error'
  | 'asset_mismatch'
  | 'payer_mismatch'
  | 'recipient_mismatch'
  | 'no_transfer'
  | 'amount_mismatch'
  | 'amount_above_maximum';

/** What `reconcilePayment` checks the chain against: the selected offer (a `PaymentOffer` fits). */
export interface ReconcileOffer {
  scheme: 'exact' | 'upto';
  /** Atomic offer amount: the price for `exact`, the authorised maximum for `upto`. */
  amount: string;
  /** The token the offer pays in (defaults to `network.asset.address`). */
  asset?: Address;
  payTo: Address;
  network: PaymentNetwork;
}

export interface ReconcileOptions {
  /** The address that paid. Defaults to the receipt's `payer`; without either, transfers from any sender count. */
  payer?: Address;
  /** Client for the offer's network (one is created from `network.rpcUrl` otherwise). */
  client?: PublicClient;
}

/**
 * The charge three ways: what was authorised, what the server reported, and what the chain shows.
 * Amounts are atomic.
 */
export interface PaymentReconciliation {
  status: ReconciliationStatus;
  /** Set when `status` is `mismatch` or `unresolved`. */
  reason?: ReconciliationReason;
  /** Human-readable explanation of the outcome. */
  message: string;
  /** The most the payer authorised (the offer amount). */
  authorized: bigint;
  /** The charge the receipt reported, if any (for `exact`, the price when the receipt reports success). */
  reported?: bigint;
  /**
   * The amount of the offer's token the chain shows moving from the payer to `payTo` in the
   * settlement transaction. Set once the transaction was found (0n when it reverted, or when
   * `no_charge`); undefined when `unresolved`.
   */
  confirmed?: bigint;
  transaction?: `0x${string}`;
  /** The settlement as read from the chain, when the transaction was found. */
  settlement?: Settlement;
}

/**
 * Check a payment receipt against the chain: the transaction it names must be on the offer's
 * network, have succeeded, and move the offer's token from the payer to the offer's recipient, for
 * exactly the price (`exact`) or for no more than the maximum and exactly the reported charge
 * (`upto`). A successful `upto` receipt that omitted the charge is resolved here: `confirmed` is the
 * amount the chain shows.
 *
 * A failure receipt that names a transaction (a pending settlement, or a failure reported after the
 * transaction was broadcast) is checked the same way, as a claim to pay the offer: `confirmed` means
 * the payment settled despite the report, `reverted` that it definitively did not, `unresolved` that
 * the chain does not show it yet. For `exact`, `reported` is then the price; for `upto`, unset.
 *
 * Never throws for missing evidence: a receipt without a transaction, a transaction the node does
 * not know yet, or an RPC failure yields `unresolved`, which is not proof that the payment failed.
 */
export async function reconcilePayment(receipt: PaymentReceipt, offer: ReconcileOffer, options: ReconcileOptions = {}): Promise<PaymentReconciliation> {
  const authorized = BigInt(offer.amount);
  const reportedRaw = receipt.charge ? receipt.charge.reported : receipt.amount;
  // A failure receipt that names a transaction (a pending settlement, or a failure the facilitator
  // reports after broadcasting) is checked on chain like a success: the chain, not the report, decides.
  const claimsTransaction = receipt.success || (typeof receipt.transaction === 'string' && receipt.transaction.length > 0);
  const reported =
    offer.scheme === 'exact' && claimsTransaction
      ? authorized
      : receipt.success && reportedRaw !== undefined && /^[0-9]+$/.test(reportedRaw)
        ? BigInt(reportedRaw)
        : undefined;
  const base = { authorized, reported };
  const unresolved = (reason: ReconciliationReason, message: string, transaction?: `0x${string}`): PaymentReconciliation => ({ ...base, status: 'unresolved', reason, message, transaction });

  if (!claimsTransaction) {
    return { ...base, reported: undefined, status: 'unresolved', reason: 'receipt_failed', message: 'The receipt reports a failed settlement; there is no settlement to confirm' };
  }
  if (receipt.network !== offer.network.network && !offer.network.v1Names.includes(receipt.network)) {
    return { ...base, status: 'mismatch', reason: 'network_mismatch', message: `The receipt names ${JSON.stringify(receipt.network)}, but the offer is on ${offer.network.network}` };
  }
  const tx = receipt.transaction;
  if (!tx) {
    if (offer.scheme === 'upto' && reported === 0n) {
      return { ...base, status: 'no_charge', confirmed: 0n, message: 'The receipt reports a zero charge; no settlement transaction was expected' };
    }
    return unresolved('no_transaction', 'The receipt names no settlement transaction');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) {
    return { ...base, status: 'mismatch', reason: 'malformed_transaction', message: `The receipt's transaction ${JSON.stringify(tx)} is not a transaction hash` };
  }
  const hash = tx as `0x${string}`;

  let chainReceipt: TransactionReceipt | undefined;
  try {
    chainReceipt = await readReceipt(clientFor(offer.network, options.client), hash);
  } catch (e) {
    return unresolved('rpc_error', `Could not read the transaction from ${offer.network.name}: ${(e as Error).message}`, hash);
  }
  if (!chainReceipt) return unresolved('not_found', `${offer.network.name} does not know transaction ${hash} yet`, hash);

  const token = (offer.asset ?? offer.network.asset.address).toLowerCase();
  const settlement = toSettlement(offer.network, hash, chainReceipt, token as Address);
  const found = { ...base, transaction: hash, settlement };
  if (chainReceipt.status !== 'success') {
    return { ...found, status: 'reverted', confirmed: 0n, message: `Transaction ${hash} reverted` };
  }

  const payer = (options.payer ?? receipt.payer)?.toLowerCase();
  const payTo = offer.payTo.toLowerCase();
  const all = tokenTransfers(chainReceipt);
  const fromPayer = (t: { from: Address }) => !payer || t.from.toLowerCase() === payer;
  const toPayTo = (t: { to: Address }) => t.to.toLowerCase() === payTo;
  const ofToken = (t: { token: Address }) => t.token.toLowerCase() === token;
  const confirmed = all.filter((t) => ofToken(t) && fromPayer(t) && toPayTo(t)).reduce((sum, t) => sum + t.amount, 0n);

  if (confirmed === 0n && !(offer.scheme === 'upto' && reported === 0n)) {
    const mismatch = (reason: ReconciliationReason, message: string): PaymentReconciliation => ({ ...found, status: 'mismatch', reason, confirmed, message });
    if (all.some((t) => !ofToken(t) && fromPayer(t) && toPayTo(t))) return mismatch('asset_mismatch', `Transaction ${hash} pays ${offer.payTo} in another token than ${offer.asset ?? offer.network.asset.address}`);
    if (all.some((t) => ofToken(t) && fromPayer(t) && !toPayTo(t))) return mismatch('recipient_mismatch', `Transaction ${hash} moves the payer's tokens to another address than ${offer.payTo}`);
    if (all.some((t) => ofToken(t) && !fromPayer(t) && toPayTo(t))) return mismatch('payer_mismatch', `Transaction ${hash} pays ${offer.payTo} from another address than the payer`);
    return mismatch('no_transfer', `Transaction ${hash} moves no ${offer.network.asset.symbol} from the payer to ${offer.payTo}`);
  }
  const done = { ...found, confirmed };
  if (offer.scheme === 'exact' && confirmed !== authorized) {
    return { ...done, status: 'mismatch', reason: 'amount_mismatch', message: `Transaction ${hash} pays ${confirmed}, but the price is ${authorized}` };
  }
  if (confirmed > authorized) {
    return { ...done, status: 'mismatch', reason: 'amount_above_maximum', message: `Transaction ${hash} pays ${confirmed}, above the authorised maximum ${authorized}` };
  }
  if (reported !== undefined && confirmed !== reported) {
    return { ...done, status: 'mismatch', reason: 'amount_mismatch', message: `Transaction ${hash} pays ${confirmed}, but the receipt reports ${reported}` };
  }
  return { ...done, status: 'confirmed', message: `Transaction ${hash} pays ${confirmed} to ${offer.payTo}` };
}
