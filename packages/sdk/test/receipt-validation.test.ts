/**
 * Receipt validation against the selected offer, and reconciliation of a receipt against chain
 * evidence. The chain is a stubbed `getTransactionReceipt`; nothing here touches a network.
 */
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createRadiusFetch, reconcilePayment, validatePaymentReceipt, RadiusPaymentError, type InvalidReceiptDetails, type PaymentReceipt, type ReconcileOffer } from '../src/client/index.js';
import { resolveNetwork } from '../src/networks.js';
import { toReceipt } from '../src/server/index.js';

const NETWORK = resolveNetwork('base-sepolia', { rpcUrl: 'http://127.0.0.1:1' });
const RADIUS = resolveNetwork('testnet', { rpcUrl: 'http://127.0.0.1:1' });
const ASSET = NETWORK.asset.address;
const OTHER_TOKEN = '0x00000000000000000000000000000000000070ce' as Address;
const PAYER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d').address;
const PAY_TO = '0x000000000000000000000000000000000000dEaD' as Address;
const STRANGER = '0x0000000000000000000000000000000000000bad' as Address;
const FEE_SINK = '0x00000000000000000000000000000000000000fe' as Address;
const TX = `0x${'ab'.repeat(32)}` as Hex;

const exactOffer: ReconcileOffer = { scheme: 'exact', amount: '1000', asset: ASSET, payTo: PAY_TO, network: NETWORK };
const uptoOffer: ReconcileOffer = { ...exactOffer, scheme: 'upto', amount: '5000' };

const receipt = (r: Partial<PaymentReceipt> = {}): PaymentReceipt => ({ success: true, protocol: 'x402', transaction: TX, network: NETWORK.network, payer: PAYER, ...r });

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const transfer = (token: Address, from: Address, to: Address, value: bigint) => ({
  address: token,
  topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from, to } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  blockNumber: 7n,
  logIndex: 0,
  transactionHash: TX,
});

/** A client whose node answers `getTransactionReceipt` with `logs` (or an error / not-found). */
function chain(logs: ReturnType<typeof transfer>[], opts: { status?: 'success' | 'reverted'; error?: string } = {}): PublicClient {
  return {
    getTransactionReceipt: async () => {
      if (opts.error) throw new Error(opts.error);
      return { status: opts.status ?? 'success', blockNumber: 7n, logs };
    },
  } as unknown as PublicClient;
}

function invalid(fn: () => unknown): InvalidReceiptDetails {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RadiusPaymentError);
    expect((e as RadiusPaymentError).code).toBe('invalid_receipt');
    return (e as RadiusPaymentError).details as InvalidReceiptDetails;
  }
  throw new Error('expected invalid_receipt');
}

describe('validatePaymentReceipt', () => {
  const exact = { scheme: 'exact' as const, amount: '1000', network: NETWORK, asset: ASSET, payer: PAYER };
  const upto = { ...exact, scheme: 'upto' as const, amount: '5000' };

  it('accepts a valid exact receipt and records the price as implied', () => {
    expect(validatePaymentReceipt(receipt(), exact)).toMatchObject({ amount: '1000', asset: ASSET, decimals: 6, charge: { scheme: 'exact', authorized: '1000', evidence: 'implied' } });
  });

  it('accepts a valid upto receipt and keeps the reported charge apart from the maximum', () => {
    expect(validatePaymentReceipt(receipt({ amount: '1234' }), upto)).toMatchObject({ amount: '1234', charge: { authorized: '5000', reported: '1234', evidence: 'reported' } });
  });

  it('does not turn a missing upto amount into the maximum', () => {
    const r = validatePaymentReceipt(receipt(), upto);
    expect(r.amount).toBeUndefined();
    expect(r.charge).toEqual({ scheme: 'upto', authorized: '5000', evidence: 'incomplete' });
  });

  it('accepts a zero upto charge with no transaction', () => {
    expect(validatePaymentReceipt(receipt({ amount: '0', transaction: undefined }), upto).charge?.evidence).toBe('zero');
  });

  it('rejects a receipt from another network: a Radius receipt cannot satisfy a Base offer', () => {
    expect(invalid(() => validatePaymentReceipt(receipt({ network: RADIUS.network }), exact)).reason).toBe('network_mismatch');
    expect(invalid(() => validatePaymentReceipt(receipt({ network: '' }), exact)).reason).toBe('network_mismatch');
    expect(invalid(() => validatePaymentReceipt(receipt({ network: NETWORK.network }), { ...exact, network: RADIUS.network })).reason).toBe('network_mismatch');
  });

  it('accepts a network named by its x402 v1 alias', () => {
    const alias = NETWORK.v1Names[0];
    expect(alias).toBeDefined();
    expect(validatePaymentReceipt(receipt({ network: alias }), exact).success).toBe(true);
  });

  it('rejects another payer, a malformed transaction, and malformed, mismatched or over-limit amounts', () => {
    expect(invalid(() => validatePaymentReceipt(receipt({ payer: STRANGER }), exact)).reason).toBe('payer_mismatch');
    expect(validatePaymentReceipt(receipt({ payer: PAYER.toLowerCase() }), exact).success).toBe(true);
    expect(invalid(() => validatePaymentReceipt(receipt({ transaction: '0x1234' }), exact)).reason).toBe('malformed_transaction');
    expect(invalid(() => validatePaymentReceipt(receipt({ transaction: undefined }), exact)).reason).toBe('missing_transaction');
    expect(invalid(() => validatePaymentReceipt(receipt({ amount: '10', transaction: undefined }), upto)).reason).toBe('missing_transaction');
    expect(invalid(() => validatePaymentReceipt(receipt({ amount: '1.5' }), upto)).reason).toBe('malformed_amount');
    expect(invalid(() => validatePaymentReceipt(receipt({ amount: '999' }), exact)).reason).toBe('amount_mismatch');
    expect(invalid(() => validatePaymentReceipt(receipt({ amount: '5001' }), upto)).reason).toBe('amount_above_maximum');
  });

  it('records a failed receipt as failed without a charge', () => {
    const r = validatePaymentReceipt(receipt({ success: false, transaction: undefined, network: RADIUS.network, errorReason: 'insufficient_funds' }), upto);
    expect(r).toMatchObject({ success: false, amount: undefined, charge: { evidence: 'failed', authorized: '5000' } });
  });
});

describe('reconcilePayment', () => {
  it('confirms a valid exact payment, ignoring the facilitator fee transfer in the same transaction', async () => {
    const client = chain([transfer(ASSET, PAYER, PAY_TO, 1000n), transfer(ASSET, PAYER, FEE_SINK, 3n)]);
    const r = await reconcilePayment(receipt({ amount: '1000' }), exactOffer, { client });
    expect(r).toMatchObject({ status: 'confirmed', authorized: 1000n, reported: 1000n, confirmed: 1000n, transaction: TX });
    expect(r.settlement?.paid(PAY_TO)).toBe(1000n);
  });

  it('confirms a valid upto payment for the reported charge', async () => {
    const r = await reconcilePayment(receipt({ amount: '1234' }), uptoOffer, { client: chain([transfer(ASSET, PAYER, PAY_TO, 1234n)]) });
    expect(r).toMatchObject({ status: 'confirmed', authorized: 5000n, reported: 1234n, confirmed: 1234n });
  });

  it('resolves an upto receipt that omitted the charge from the chain', async () => {
    const validated = validatePaymentReceipt(receipt(), { scheme: 'upto', amount: '5000', network: NETWORK });
    const r = await reconcilePayment(validated, uptoOffer, { client: chain([transfer(ASSET, PAYER, PAY_TO, 42n)]) });
    expect(r).toMatchObject({ status: 'confirmed', reported: undefined, confirmed: 42n });
  });

  it('reports a zero upto charge without a transaction as no_charge, without reading the chain', async () => {
    const r = await reconcilePayment(receipt({ amount: '0', transaction: undefined }), uptoOffer, { client: chain([], { error: 'must not be called' }) });
    expect(r).toMatchObject({ status: 'no_charge', confirmed: 0n, reported: 0n });
  });

  it('reports a reverted settlement', async () => {
    const r = await reconcilePayment(receipt(), exactOffer, { client: chain([], { status: 'reverted' }) });
    expect(r).toMatchObject({ status: 'reverted', confirmed: 0n });
  });

  it('flags evidence in the wrong asset, to the wrong payee, or from the wrong payer', async () => {
    const wrongAsset = await reconcilePayment(receipt(), exactOffer, { client: chain([transfer(OTHER_TOKEN, PAYER, PAY_TO, 1000n)]) });
    expect(wrongAsset).toMatchObject({ status: 'mismatch', reason: 'asset_mismatch', confirmed: 0n });
    const wrongPayee = await reconcilePayment(receipt(), exactOffer, { client: chain([transfer(ASSET, PAYER, STRANGER, 1000n)]) });
    expect(wrongPayee).toMatchObject({ status: 'mismatch', reason: 'recipient_mismatch' });
    const wrongPayer = await reconcilePayment(receipt(), exactOffer, { client: chain([transfer(ASSET, STRANGER, PAY_TO, 1000n)]) });
    expect(wrongPayer).toMatchObject({ status: 'mismatch', reason: 'payer_mismatch' });
    const nothing = await reconcilePayment(receipt(), exactOffer, { client: chain([]) });
    expect(nothing).toMatchObject({ status: 'mismatch', reason: 'no_transfer' });
  });

  it('flags amounts that differ from the price, the reported charge, or exceed the maximum', async () => {
    expect(await reconcilePayment(receipt(), exactOffer, { client: chain([transfer(ASSET, PAYER, PAY_TO, 999n)]) })).toMatchObject({ status: 'mismatch', reason: 'amount_mismatch', confirmed: 999n });
    expect(await reconcilePayment(receipt({ amount: '100' }), uptoOffer, { client: chain([transfer(ASSET, PAYER, PAY_TO, 200n)]) })).toMatchObject({ status: 'mismatch', reason: 'amount_mismatch' });
    expect(await reconcilePayment(receipt(), uptoOffer, { client: chain([transfer(ASSET, PAYER, PAY_TO, 5001n)]) })).toMatchObject({ status: 'mismatch', reason: 'amount_above_maximum' });
  });

  it('flags a receipt from another network', async () => {
    expect(await reconcilePayment(receipt({ network: RADIUS.network }), exactOffer, { client: chain([]) })).toMatchObject({ status: 'mismatch', reason: 'network_mismatch' });
  });

  it('is unresolved, not failed, when the evidence is unavailable', async () => {
    expect(await reconcilePayment(receipt({ transaction: undefined }), exactOffer, { client: chain([]) })).toMatchObject({ status: 'unresolved', reason: 'no_transaction' });
    expect(await reconcilePayment(receipt(), exactOffer, { client: chain([], { error: `Transaction with hash "${TX}" could not be found.` }) })).toMatchObject({ status: 'unresolved', reason: 'not_found', transaction: TX });
    expect(await reconcilePayment(receipt(), exactOffer, { client: chain([], { error: 'socket hang up' }) })).toMatchObject({ status: 'unresolved', reason: 'rpc_error' });
    expect(await reconcilePayment(receipt({ success: false, transaction: undefined }), exactOffer, { client: chain([]) })).toMatchObject({ status: 'unresolved', reason: 'receipt_failed' });
  });

  it('is available on payFetch, with this wallet as the payer', async () => {
    const payFetch = createRadiusFetch({ signer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', network: 'base-sepolia', maxPerRequest: '0.01', fetch: async () => new Response(null) });
    const client = chain([transfer(ASSET, STRANGER, PAY_TO, 1000n)]);
    // The receipt names no payer: payFetch's own address decides whose transfer counts.
    expect(await payFetch.reconcilePayment(receipt({ payer: undefined }), exactOffer, { client })).toMatchObject({ status: 'mismatch', reason: 'payer_mismatch' });
    expect(await payFetch.reconcilePayment(receipt({ payer: undefined }), exactOffer, { client: chain([transfer(ASSET, PAYER, PAY_TO, 1000n)]) })).toMatchObject({ status: 'confirmed' });
  });
});

describe('toReceipt (server)', () => {
  it('adds the asset, decimals and charge, and never fills a missing upto amount with the maximum', () => {
    const settled = { success: true, transaction: TX, network: NETWORK.network, payer: PAYER } as const;
    expect(toReceipt(settled, NETWORK, { amount: '1000', scheme: 'exact', asset: ASSET })).toMatchObject({ amount: '1000', asset: ASSET, decimals: 6, charge: { scheme: 'exact', authorized: '1000', evidence: 'implied' } });
    const upto = toReceipt(settled, NETWORK, { amount: '5000', scheme: 'upto', asset: ASSET });
    expect(upto.amount).toBeUndefined();
    expect(upto.charge?.evidence).toBe('incomplete');
    expect(toReceipt({ ...settled, transaction: '', amount: '0' }, NETWORK, { amount: '5000', scheme: 'upto' }).charge?.evidence).toBe('zero');
    expect(toReceipt({ ...settled, success: false, errorReason: 'x' }, NETWORK, { amount: '1000' }).charge?.evidence).toBe('failed');
  });
});
