import { decodePaymentResponseHeader } from '@x402/core/http';
import { explorerTxUrl, type PaymentNetwork } from './networks.js';
import { MPP_RECEIPT_HEADER, parseMppReceipt } from './mpp.js';
import { RadiusPaymentError } from './errors.js';
import { classifySettlement, type SettlementClassifier } from './outcome.js';

/** Decoded `PAYMENT-RESPONSE` (x402) or `Payment-Receipt` (MPP) header: what was settled. */
export interface PaymentReceipt {
  success: boolean;
  /** Which protocol paid. */
  protocol?: 'x402' | 'mpp';
  /** Settlement transaction hash (empty/undefined when settlement failed). */
  transaction?: string;
  /** CAIP-2 network the settlement happened on. */
  network: string;
  payer?: string;
  /**
   * Atomic amount charged, as reported. For the `exact` scheme this is the requested amount;
   * facilitators only report it themselves for schemes (like `upto`) where it can differ. A
   * successful `upto` receipt that omits it leaves it undefined (`charge.evidence: 'incomplete'`):
   * it is never read as the authorised maximum.
   */
  amount?: string;
  errorReason?: string;
  errorMessage?: string;
  explorerUrl?: string;
  /**
   * Payment asset (token address) of the offer. Not part of the protocol response: radius-sdk fills
   * it from the offer the receipt was checked against.
   */
  asset?: string;
  /** Decimals of `asset`, filled by radius-sdk alongside it. */
  decimals?: number;
  /**
   * What the receipt says about the charge, filled by radius-sdk when it checks the receipt against
   * the offer. It is the server's report, not chain evidence: use `reconcilePayment` for that.
   */
  charge?: PaymentCharge;
}

/**
 * How much evidence a receipt carries about the amount charged. More values may be added later;
 * treat a value you do not recognise as unverified.
 *
 * - `reported`: the server reported the actual charge (`charge.reported`).
 * - `implied`: `exact` scheme; the server reported success and the scheme fixes the charge at the offered amount.
 * - `zero`: `upto` scheme; the server reported a zero charge, so no settlement transaction is expected.
 * - `incomplete`: `upto` scheme; the server reported success without the actual charge. Anything from
 *   zero to `charge.authorized` may have moved; reconcile the transaction on chain to learn the amount.
 * - `failed`: the server reported that settlement failed.
 * - `pending`: the server reported that settlement was submitted but has no final result yet
 *   (`errorReason: 'settlement_pending'`). Nothing is proven either way; `transaction`, when set, is
 *   the broadcast hash to reconcile. Present the same payment again rather than signing another.
 */
export type ChargeEvidence = 'reported' | 'implied' | 'zero' | 'incomplete' | 'failed' | 'pending';

/** The charge as the receipt describes it, kept apart from what the chain confirms. Amounts are atomic strings. */
export interface PaymentCharge {
  scheme: 'exact' | 'upto';
  /** The most the payer authorised: the offer amount (for `exact`, also the price). */
  authorized: string;
  /** The actual charge the server or facilitator reported, when it reported one. */
  reported?: string;
  evidence: ChargeEvidence;
}

/** What a receipt is checked against: the selected offer, and optionally the payer. */
export interface ReceiptExpectation {
  scheme: 'exact' | 'upto';
  /** Atomic offer amount: the price for `exact`, the authorised maximum for `upto`. */
  amount: string;
  /** The offer's network (a `PaymentNetwork` or its CAIP-2 id). */
  network: PaymentNetwork | string;
  /** The offer's payment asset; copied to the receipt with its decimals. */
  asset?: string;
  /** Decimals of `asset` (taken from `network` when it is a `PaymentNetwork` with the same asset). */
  decimals?: number;
  /** The address that signed the payment. A receipt naming another payer is rejected. */
  payer?: string;
  /** Recognises a pending failure receipt (`charge.evidence: 'pending'`). Default `classifySettlement`. */
  classify?: SettlementClassifier;
}

/** Why `validatePaymentReceipt` rejected a receipt (`RadiusPaymentError` code `invalid_receipt`). */
export type InvalidReceiptReason =
  | 'malformed'
  | 'network_mismatch'
  | 'payer_mismatch'
  | 'malformed_transaction'
  | 'missing_transaction'
  | 'malformed_amount'
  | 'amount_mismatch'
  | 'amount_above_maximum';

/** `details` of an `invalid_receipt` error. */
export interface InvalidReceiptDetails {
  reason: InvalidReceiptReason;
  /** The decoded receipt, when the header could be decoded. */
  receipt?: PaymentReceipt;
  /** The response that carried the receipt (body unread), when the client rejected it after a paid request. */
  response?: Response;
  cause?: unknown;
}

export const PAYMENT_RESPONSE_HEADER = 'payment-response';
const ATOMIC_AMOUNT = /^[0-9]+$/;
const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Validate the amount a facilitator reports for an `upto` payment. It is an untrusted receipt field:
 * it must be a non-negative integer string and must not exceed the maximum the payer signed.
 */
export function parseUptoSettlementAmount(amount: string, maximum: bigint): bigint {
  if (!ATOMIC_AMOUNT.test(amount)) {
    throw new Error("payment response: 'amount' must be a non-negative integer string");
  }
  const settled = BigInt(amount);
  if (settled > maximum) {
    throw new Error(`payment response: settlement amount ${settled} exceeds authorized maximum ${maximum}`);
  }
  return settled;
}

export function decodePaymentReceipt(headerValue: string, network?: PaymentNetwork, expected?: { amount: string }): PaymentReceipt {
  const r = decodePaymentResponseHeader(headerValue) as Record<string, unknown>;
  if (r.amount !== undefined && (typeof r.amount !== 'string' || !ATOMIC_AMOUNT.test(r.amount))) {
    const details: InvalidReceiptDetails = { reason: 'malformed_amount' };
    throw new RadiusPaymentError('invalid_receipt', "payment response: 'amount' must be a non-negative integer string", details);
  }
  const transaction = typeof r.transaction === 'string' && r.transaction.length > 0 ? r.transaction : undefined;
  return {
    success: r.success === true,
    protocol: 'x402',
    transaction,
    network: typeof r.network === 'string' ? r.network : '',
    payer: typeof r.payer === 'string' ? r.payer : undefined,
    amount: typeof r.amount === 'string' ? r.amount : r.success === true ? expected?.amount : undefined,
    errorReason: typeof r.errorReason === 'string' ? r.errorReason : undefined,
    errorMessage: typeof r.errorMessage === 'string' ? r.errorMessage : undefined,
    explorerUrl: transaction && network ? explorerTxUrl(network, transaction) : undefined,
  };
}

/**
 * Read the payment receipt from a Response (or Headers), if the server attached one: x402's
 * `PAYMENT-RESPONSE`, else MPP's `Payment-Receipt` (which names no payer or network; `network`
 * fills the latter).
 */
export function getPaymentReceipt(source: Response | Headers, network?: PaymentNetwork): PaymentReceipt | undefined {
  const headers = source instanceof Headers ? source : source.headers;
  const v = headers.get(PAYMENT_RESPONSE_HEADER) ?? headers.get('x-payment-response');
  try {
    if (v) return decodePaymentReceipt(v, network);
    const mpp = headers.get(MPP_RECEIPT_HEADER);
    return mpp ? decodeMppReceipt(mpp, network) : undefined;
  } catch {
    return undefined;
  }
}

/** Decode a `Payment-Receipt` (MPP). It names the transaction only; `network` fills in the network and explorer link. */
export function decodeMppReceipt(headerValue: string, network?: PaymentNetwork): PaymentReceipt {
  const r = parseMppReceipt(headerValue);
  return {
    success: true,
    protocol: 'mpp',
    transaction: r.reference || undefined,
    network: network?.network ?? '',
    explorerUrl: r.reference && network ? explorerTxUrl(network, r.reference) : undefined,
  };
}

function invalidReceipt(reason: InvalidReceiptReason, message: string, receipt?: PaymentReceipt): RadiusPaymentError {
  const details: InvalidReceiptDetails = { reason, receipt };
  return new RadiusPaymentError('invalid_receipt', `Invalid payment response: ${message}`, details);
}

/**
 * Check a decoded x402 receipt against the offer it pays for, and return a copy completed with the
 * charge evidence and the asset. Throws `RadiusPaymentError` `invalid_receipt` (details:
 * `InvalidReceiptDetails`) when a successful receipt:
 *
 * - names a different network than the offer (a Radius receipt cannot satisfy a Base offer),
 * - names a different payer than `expected.payer`,
 * - has a transaction that is not a 32-byte hex hash, or no transaction for a non-zero charge,
 * - reports an amount that is malformed, differs from an `exact` price, or exceeds the `upto` maximum.
 *
 * A failure receipt is not rejected: its `charge.evidence` is `pending` when it reports a pending
 * settlement (a transaction it names must still be a hash), else `failed`.
 *
 * A successful `upto` receipt without an amount is not rejected, but it is not read as the maximum
 * either: `amount` stays undefined and `charge.evidence` is `incomplete`. A reported zero charge
 * needs no transaction (`charge.evidence` is `zero`). For `exact`, `amount` is the offer price.
 *
 * Passing validation means the receipt is consistent with the offer, not that settlement happened:
 * the receipt is the server's claim. `reconcilePayment` checks the chain.
 */
export function validatePaymentReceipt(receipt: PaymentReceipt, expected: ReceiptExpectation): PaymentReceipt {
  const network = typeof expected.network === 'string' ? undefined : expected.network;
  const expectedNetwork = typeof expected.network === 'string' ? expected.network : expected.network.network;
  const asset = expected.asset ?? network?.asset.address;
  const decimals =
    expected.decimals ?? (network && asset && network.asset.address.toLowerCase() === asset.toLowerCase() ? network.asset.decimals : undefined);
  const out: PaymentReceipt = { ...receipt, asset: asset ?? receipt.asset, decimals: decimals ?? receipt.decimals };
  const authorized = expected.amount;
  if (!ATOMIC_AMOUNT.test(authorized)) throw new Error(`validatePaymentReceipt: expected.amount must be a non-negative integer string (got ${JSON.stringify(authorized)})`);
  // Decode without `expected`, so `amount` is what the server sent rather than a filled-in price.
  const reported = receipt.amount === undefined ? undefined : String(receipt.amount);

  if (!receipt.success) {
    const pending = (expected.classify ?? classifySettlement)(receipt) === 'pending';
    if (pending && receipt.transaction !== undefined && !EVM_TX_HASH.test(receipt.transaction)) {
      throw invalidReceipt('malformed_transaction', `transaction ${JSON.stringify(receipt.transaction)} is not a 32-byte hex hash`, receipt);
    }
    return { ...out, amount: undefined, charge: { scheme: expected.scheme, authorized, reported: undefined, evidence: pending ? 'pending' : 'failed' } };
  }
  // x402 v1 receipts may name the network by its v1 alias.
  const accepted = network ? [network.network, ...network.v1Names] : [expectedNetwork];
  if (!accepted.includes(receipt.network)) {
    throw invalidReceipt('network_mismatch', `settled on ${JSON.stringify(receipt.network)}, but the offer is on ${expectedNetwork}`, receipt);
  }
  if (expected.payer && receipt.payer !== undefined && receipt.payer.toLowerCase() !== expected.payer.toLowerCase()) {
    throw invalidReceipt('payer_mismatch', `payer ${receipt.payer} is not the signer ${expected.payer}`, receipt);
  }
  if (receipt.transaction !== undefined && !EVM_TX_HASH.test(receipt.transaction)) {
    throw invalidReceipt('malformed_transaction', `transaction ${JSON.stringify(receipt.transaction)} is not a 32-byte hex hash`, receipt);
  }
  if (reported !== undefined && !ATOMIC_AMOUNT.test(reported)) {
    throw invalidReceipt('malformed_amount', "'amount' must be a non-negative integer string", receipt);
  }

  if (expected.scheme === 'exact') {
    if (reported !== undefined && BigInt(reported) !== BigInt(authorized)) {
      throw invalidReceipt('amount_mismatch', `exact payment reports amount ${reported}, but the price is ${authorized}`, receipt);
    }
    if (!receipt.transaction) throw invalidReceipt('missing_transaction', 'a successful exact payment names no transaction', receipt);
    return { ...out, amount: authorized, charge: { scheme: 'exact', authorized, reported, evidence: reported === undefined ? 'implied' : 'reported' } };
  }

  // upto
  if (reported === undefined) {
    return { ...out, amount: undefined, charge: { scheme: 'upto', authorized, evidence: 'incomplete' } };
  }
  const charged = BigInt(reported);
  if (charged > BigInt(authorized)) {
    throw invalidReceipt('amount_above_maximum', `settlement amount ${charged} exceeds authorized maximum ${authorized}`, receipt);
  }
  if (charged > 0n && !receipt.transaction) {
    throw invalidReceipt('missing_transaction', `a charge of ${charged} names no transaction`, receipt);
  }
  return { ...out, amount: reported, charge: { scheme: 'upto', authorized, reported, evidence: charged === 0n ? 'zero' : 'reported' } };
}

