/**
 * Wire-level parity tests for `createRadiusFetch`, ported from radius-cli's
 * `tests/x402-{protocol,upto,eip3009}.test.ts`: header names, decoded payload shape, and
 * EIP-712 signatures that recover to the signer. Nothing here touches the network: the paid
 * request goes to a mock fetch and, where a flow needs the RPC (Permit2 allowance, EIP-2612
 * nonce), JSON-RPC is stubbed on the global fetch.
 */
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maxUint256, recoverTypedDataAddress, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createRadiusFetch, getPaymentReceipt, RadiusPaymentError, type ApprovalRequest, type InvalidChallengeDetails, type PaymentOffer, type PaymentReceipt, type PaymentRejectedDetails, type RadiusFetchOptions } from '../src/client/index.js';
import { PERMIT2_ADDRESS, X402_EXACT_PERMIT2_PROXY, resolveNetwork } from '../src/networks.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const SIGNER = privateKeyToAccount(PK);
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;
const PAY_TO = '0x000000000000000000000000000000000000dEaD' as Address;
const FACILITATOR = '0x00000000000000000000000000000000fac11107' as Address;
const X402_UPTO_PERMIT2_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';
const CHAIN_ID = 84532;
const NETWORK_ID = `eip155:${CHAIN_ID}`;
const RESOURCE_URL = 'https://api.example.com/r';

// The CLI tests' chain 84532 / USDC is the Base Sepolia preset; the RPC goes nowhere (stubbed where needed).
const NETWORK = resolveNetwork('base-sepolia', { rpcUrl: 'http://127.0.0.1:1' });

// EIP-712 type sets exactly as the CLI defines them (Witness member order is load-bearing).
const PERMIT2_UPTO_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'facilitator', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const;
const PERMIT2_EXACT_TYPES = {
  PermitWitnessTransferFrom: PERMIT2_UPTO_TYPES.PermitWitnessTransferFrom,
  TokenPermissions: PERMIT2_UPTO_TYPES.TokenPermissions,
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const;
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;
const PERMIT2_DOMAIN = { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2_ADDRESS } as const;
const USDC_DOMAIN = { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: ASSET } as const;

// -- challenges (same fixtures as the CLI tests) ------------------------------------------------

const EXACT_EIP3009 = {
  scheme: 'exact',
  network: NETWORK_ID,
  asset: ASSET,
  payTo: PAY_TO,
  amount: '13000',
  maxTimeoutSeconds: 120,
  extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' },
};
const EXACT_PERMIT2 = { ...EXACT_EIP3009, extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } };
const UPTO = {
  scheme: 'upto',
  network: NETWORK_ID,
  asset: ASSET,
  payTo: PAY_TO,
  amount: '500000',
  maxTimeoutSeconds: 120,
  extra: { name: 'USDC', version: '2', facilitatorAddress: FACILITATOR },
};
const V1_EXACT = {
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: NETWORK_ID,
      asset: ASSET,
      payTo: PAY_TO,
      maxAmountRequired: '13000',
      resource: '/example',
      description: 'access fee',
      mimeType: 'application/json',
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2' },
    },
  ],
  error: 'X-PAYMENT required',
};

function v2(accept: Record<string, unknown>, extensions?: Record<string, unknown>) {
  return { x402Version: 2, resource: { url: RESOURCE_URL, description: 'r' }, accepts: [accept], ...(extensions ? { extensions } : {}) };
}

// -- helpers ------------------------------------------------------------------------------------

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
const fromB64 = (s: string) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const lower = (s: unknown) => String(s).toLowerCase();

interface MockServer {
  fetch: typeof globalThis.fetch;
  requests: Request[];
}

/** A seller that answers unpaid requests with `challenge` (v2: header, v1: body) and paid ones with `paid()`. */
function seller(challenge: unknown, paid: () => Response = () => Response.json({ ok: true }), opts: { challengeInBody?: boolean } = {}): MockServer {
  const requests: Request[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req);
    if (req.headers.has('payment-signature') || req.headers.has('x-payment')) return paid();
    const version = (challenge as { x402Version: number }).x402Version;
    if (version === 2 && !opts.challengeInBody) return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': b64(challenge) } });
    return Response.json(challenge, { status: 402 });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function paidWithReceipt(receipt: Record<string, unknown>, status = 200) {
  return () => Response.json({ ok: true }, { status, headers: { 'PAYMENT-RESPONSE': b64(receipt) } });
}

/** Stub viem's JSON-RPC transport (global fetch) so allowance / EIP-2612 nonce reads never hit a node. */
function stubRpc({ allowance = maxUint256, nonce = 0n, allowanceError = false }: { allowance?: bigint; nonce?: bigint; allowanceError?: boolean } = {}) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const body = JSON.parse(await req.text()) as { id: number; method: string; params?: [{ data?: string }] }[] | { id: number; method: string; params?: [{ data?: string }] };
    const answer = (call: { id: number; method: string; params?: [{ data?: string }] }) => {
      calls.push(call.method);
      if (call.method === 'eth_chainId') return { jsonrpc: '2.0', id: call.id, result: toHex(CHAIN_ID) };
      if (call.method === 'eth_call') {
        const selector = (call.params?.[0]?.data ?? '').slice(0, 10);
        if (allowanceError && selector === '0xdd62ed3e') return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'allowance read failed' } };
        // allowance(address,address) → 0xdd62ed3e; nonces(address) → 0x7ecebe00
        const value = selector === '0xdd62ed3e' ? allowance : selector === '0x7ecebe00' ? nonce : 0n;
        return { jsonrpc: '2.0', id: call.id, result: toHex(value, { size: 32 }) };
      }
      return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `unstubbed ${call.method}` } };
    };
    return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
  });
  return calls;
}

function buyer(server: MockServer, extra: Partial<RadiusFetchOptions> = {}) {
  return createRadiusFetch({ network: NETWORK, signer: PK, maxPerRequest: { amount: '1000000' }, fetch: server.fetch, ...extra });
}

/** Pay `challenge`, returning the retried request and its decoded payment header. */
async function pay(challenge: unknown, extra: Partial<RadiusFetchOptions> = {}, paid?: () => Response, init?: RequestInit) {
  const offers: PaymentOffer[] = [];
  const server = seller(challenge, paid);
  const res = await buyer(server, { onPaymentRequired: (o) => { offers.push(o); return true; }, ...extra })(RESOURCE_URL, init);
  const retried = server.requests[1];
  const headerName = retried?.headers.has('payment-signature') ? 'payment-signature' : 'x-payment';
  const decoded = retried?.headers.get(headerName) ? fromB64(retried.headers.get(headerName)!) : undefined;
  return { res, server, retried, headerName, decoded, offer: offers[0] };
}

const rejects = (p: Promise<unknown>, code: string, message?: RegExp) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof RadiusPaymentError && e.code === code && (!message || message.test(e.message)));

afterEach(() => vi.restoreAllMocks());

// -- exact v2 -----------------------------------------------------------------------------------

describe('exact@v2 Permit2', () => {
  it('sends PAYMENT-SIGNATURE with the spec-shaped permit2Authorization, signed for the exact proxy', async () => {
    stubRpc();
    const { server, retried, headerName, decoded, offer } = await pay(v2(EXACT_PERMIT2));
    expect(server.requests).toHaveLength(2);
    expect(retried.redirect).toBe('manual');
    expect(headerName).toBe('payment-signature');
    expect(retried.headers.get('x-payment')).toBeNull();
    expect(offer).toMatchObject({ x402Version: 2, scheme: 'exact', amount: '13000', gasSponsored: false });

    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe(RESOURCE_URL);
    // `accepted` echoes the server's requirement untouched (what a v2 server matches on).
    expect(decoded.accepted).toEqual(EXACT_PERMIT2);
    const a = decoded.payload.permit2Authorization;
    expect(a.permitted).toEqual({ token: ASSET, amount: '13000' });
    expect(a.spender).toBe(X402_EXACT_PERMIT2_PROXY);
    expect(a.from).toBe(SIGNER.address);
    expect(lower(a.witness.to)).toBe(lower(PAY_TO));
    expect(a.witness.facilitator).toBeUndefined();
    expect(typeof a.nonce).toBe('string');
    expect(typeof a.deadline).toBe('string');
    expect(typeof a.witness.validAfter).toBe('string');
    expect(BigInt(a.deadline) - BigInt(Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(120n);

    const recovered = await recoverTypedDataAddress({
      domain: PERMIT2_DOMAIN,
      types: PERMIT2_EXACT_TYPES,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) },
        spender: a.spender,
        nonce: BigInt(a.nonce),
        deadline: BigInt(a.deadline),
        witness: { to: a.witness.to, validAfter: BigInt(a.witness.validAfter) },
      },
      signature: decoded.payload.signature,
    });
    expect(lower(recovered)).toBe(lower(SIGNER.address));
  });

  it('signs the EIP-2612 permit for Permit2 when the server sponsors gas (no approval transaction)', async () => {
    const calls = stubRpc({ allowance: 0n, nonce: 7n });
    const { decoded, offer } = await pay(v2(EXACT_PERMIT2, { eip2612GasSponsoring: { version: '1' } }));
    expect(offer.gasSponsored).toBe(true);
    const info = decoded.extensions.eip2612GasSponsoring.info;
    expect(info).toMatchObject({ from: SIGNER.address, asset: ASSET, spender: PERMIT2_ADDRESS, amount: '13000', nonce: '7', version: '1' });
    expect(info.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(calls).not.toContain('eth_sendRawTransaction');
  });

  it('carries the original method and body on the paid retry', async () => {
    stubRpc();
    const { retried } = await pay(v2(EXACT_PERMIT2), {}, undefined, { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    expect(retried.method).toBe('POST');
    expect(await retried.text()).toBe('{"a":1}');
    expect(retried.headers.get('content-type')).toBe('application/json');
  });
});

describe('exact@v2 EIP-3009', () => {
  it('sends the EIP-3009 authorization with string amounts and a signature recoverable to the signer', async () => {
    const { headerName, decoded } = await pay(v2(EXACT_EIP3009));
    expect(headerName).toBe('payment-signature');
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.extra).toEqual({ assetTransferMethod: 'eip3009', name: 'USDC', version: '2' });
    const auth = decoded.payload.authorization;
    expect(auth.value).toBe('13000');
    expect(typeof auth.validAfter).toBe('string');
    expect(typeof auth.validBefore).toBe('string');
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(auth.from).toBe(SIGNER.address);
    expect(lower(auth.to)).toBe(lower(PAY_TO));

    const recovered = await recoverTypedDataAddress({
      domain: USDC_DOMAIN,
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
      signature: decoded.payload.signature,
    });
    expect(lower(recovered)).toBe(lower(SIGNER.address));
  });

  it('falls back to the configured asset EIP-712 domain when the challenge omits name/version', async () => {
    const { decoded } = await pay(v2({ ...EXACT_EIP3009, extra: { assetTransferMethod: 'eip3009' } }));
    // Echoed untouched…
    expect(decoded.accepted.extra).toEqual({ assetTransferMethod: 'eip3009' });
    // …but signed under the USDC/2 domain the network config declares.
    const auth = decoded.payload.authorization;
    const recovered = await recoverTypedDataAddress({
      domain: USDC_DOMAIN,
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
      signature: decoded.payload.signature,
    });
    expect(lower(recovered)).toBe(lower(SIGNER.address));
  });

  it('accepts a v2 challenge delivered in the JSON body instead of the header', async () => {
    const server = seller(v2(EXACT_EIP3009), undefined, { challengeInBody: true });
    const res = await buyer(server)(RESOURCE_URL);
    expect(res.status).toBe(200);
    expect(server.requests[1].headers.has('payment-signature')).toBe(true);
  });
});

// -- upto v2 ------------------------------------------------------------------------------------

describe('upto@v2', () => {
  it('sends PAYMENT-SIGNATURE with a Permit2 witness bound to the facilitator, signed for the upto proxy', async () => {
    stubRpc();
    const { headerName, decoded, offer } = await pay(v2(UPTO));
    expect(headerName).toBe('payment-signature');
    expect(offer).toMatchObject({ x402Version: 2, scheme: 'upto', amount: '500000', amountFormatted: '0.5 USDC' });

    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe(RESOURCE_URL);
    expect(decoded.accepted.scheme).toBe('upto');
    expect(decoded.accepted.amount).toBe('500000');
    // Unlike radius-cli (which trims extra to {name, version}), the full requirement is echoed:
    // @x402/core servers require their extra to be a subset of accepted.extra.
    expect(decoded.accepted.extra).toEqual({ name: 'USDC', version: '2', facilitatorAddress: FACILITATOR });

    const p = decoded.payload;
    expect(p.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(p.permit2Authorization.permitted).toEqual({ token: ASSET, amount: '500000' });
    expect(p.permit2Authorization.spender).toBe(X402_UPTO_PERMIT2_PROXY);
    expect(p.permit2Authorization.from).toBe(SIGNER.address);
    expect(lower(p.permit2Authorization.witness.to)).toBe(lower(PAY_TO));
    expect(lower(p.permit2Authorization.witness.facilitator)).toBe(lower(FACILITATOR));
    expect(Object.keys(p.permit2Authorization.witness)).toEqual(['to', 'facilitator', 'validAfter']);
    expect(typeof p.permit2Authorization.nonce).toBe('string');
    expect(typeof p.permit2Authorization.deadline).toBe('string');
    expect(typeof p.permit2Authorization.witness.validAfter).toBe('string');

    const a = p.permit2Authorization;
    const recovered = await recoverTypedDataAddress({
      domain: PERMIT2_DOMAIN,
      types: PERMIT2_UPTO_TYPES,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) },
        spender: a.spender,
        nonce: BigInt(a.nonce),
        deadline: BigInt(a.deadline),
        witness: { to: a.witness.to, facilitator: a.witness.facilitator, validAfter: BigInt(a.witness.validAfter) },
      },
      signature: p.signature,
    });
    expect(lower(recovered)).toBe(lower(SIGNER.address));
  });

  it('fails clearly, before signing anything, when the 402 extra omits the facilitator address', async () => {
    const noFacilitator = { ...UPTO, extra: { name: 'USDC', version: '2' } };
    const server = seller(v2(noFacilitator));
    await rejects(buyer(server)(RESOURCE_URL), 'invalid_challenge', /facilitatorAddress/);
    expect(server.requests).toHaveLength(1);
  });

  it('accepts the CLI alias extra.facilitator for the witness', async () => {
    stubRpc();
    const { decoded } = await pay(v2({ ...UPTO, extra: { name: 'USDC', version: '2', facilitator: FACILITATOR } }));
    expect(lower(decoded.payload.permit2Authorization.witness.facilitator)).toBe(lower(FACILITATOR));
    expect(decoded.accepted.extra).toEqual({ name: 'USDC', version: '2', facilitator: FACILITATOR });
  });

  it('compares the per-request cap against the authorised maximum', async () => {
    const server = seller(v2(UPTO));
    await rejects(buyer(server, { maxPerRequest: { amount: '499999' } })(RESOURCE_URL), 'price_above_limit', /up to 0\.5 USDC/);
    expect(server.requests).toHaveLength(1);
  });

  it('signs the EIP-2612 permit when the server sponsors gas', async () => {
    stubRpc({ allowance: 0n });
    const { decoded } = await pay(v2(UPTO, { eip2612GasSponsoring: { version: '1' } }));
    expect(decoded.extensions.eip2612GasSponsoring.info).toMatchObject({ spender: PERMIT2_ADDRESS, amount: '500000', asset: ASSET });
  });
});

describe('upto@v2 settlement receipts', () => {
  const paid = (receipt: Record<string, unknown>) => paidWithReceipt({ success: true, transaction: '0xabc', network: NETWORK_ID, payer: SIGNER.address, ...receipt });

  async function settle(receipt: Record<string, unknown>) {
    stubRpc();
    const receipts: PaymentReceipt[] = [];
    const { res } = await pay(v2(UPTO), { onPaid: (r) => { receipts.push(r); } }, paid(receipt));
    return { res, receipt: receipts[0] };
  }

  it('reports the actually charged amount (zero or partial) from the PAYMENT-RESPONSE', async () => {
    expect((await settle({ amount: '60' })).receipt.amount).toBe('60');
    expect((await settle({ amount: '0' })).receipt.amount).toBe('0');
    expect((await settle({ amount: '500000' })).receipt.amount).toBe('500000');
  });

  it('falls back to the authorised maximum when the facilitator reports no amount', async () => {
    const { res, receipt } = await settle({});
    expect(res.status).toBe(200);
    expect(receipt).toMatchObject({ success: true, amount: '500000', transaction: '0xabc' });
  });

  it('rejects a settlement above the signed maximum', async () => {
    await rejects(settle({ amount: '500001' }), 'invalid_receipt', /exceeds authorized maximum/);
  });

  it('rejects malformed or negative settlement amounts', async () => {
    await rejects(settle({ amount: '-1' }), 'invalid_receipt', /non-negative integer/);
    await rejects(settle({ amount: '1.5' }), 'invalid_receipt', /non-negative integer/);
    await rejects(settle({ amount: 'nope' }), 'invalid_receipt', /non-negative integer/);
    await rejects(settle({ amount: 5 }), 'invalid_receipt', /non-negative integer/);
  });

  it('does not treat an unsuccessful receipt as settled', async () => {
    const { receipt } = await settle({ success: false, errorReason: 'settlement_failed', transaction: '' });
    expect(receipt.success).toBe(false);
    expect(receipt.amount).toBeUndefined();
  });

  it('leaves exact receipts lenient: a malformed amount just means no receipt', async () => {
    const receipts: PaymentReceipt[] = [];
    const { res } = await pay(v2(EXACT_EIP3009), { onPaid: (r) => { receipts.push(r); } }, paid({ amount: 'nope' }));
    expect(res.status).toBe(200);
    expect(receipts).toHaveLength(0);
  });
});

// -- x402 v1 ------------------------------------------------------------------------------------

describe('exact@v1', () => {
  it('pays a v1 (maxAmountRequired) challenge with X-PAYMENT and a v1 EIP-3009 envelope', async () => {
    const { headerName, retried, decoded, offer, res } = await pay(V1_EXACT);
    expect(res.status).toBe(200);
    expect(headerName).toBe('x-payment');
    expect(retried.headers.get('payment-signature')).toBeNull();
    expect(offer).toMatchObject({ x402Version: 1, scheme: 'exact', amount: '13000', amountFormatted: '0.013 USDC', payTo: PAY_TO });
    expect(offer.resource).toEqual({ url: RESOURCE_URL, description: 'access fee', mimeType: 'application/json' });

    expect(Object.keys(decoded).sort()).toEqual(['network', 'payload', 'scheme', 'x402Version']);
    expect(decoded).toMatchObject({ x402Version: 1, scheme: 'exact', network: NETWORK_ID });
    const auth = decoded.payload.authorization;
    expect(auth.value).toBe('13000');
    expect(auth.from).toBe(SIGNER.address);
    expect(lower(auth.to)).toBe(lower(PAY_TO));
    expect(auth.validAfter).toBe('0');
    const now = Math.floor(Date.now() / 1000);
    expect(Number(auth.validBefore)).toBeGreaterThan(now);
    expect(Number(auth.validBefore)).toBeLessThanOrEqual(now + 60);

    const recovered = await recoverTypedDataAddress({
      domain: USDC_DOMAIN,
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
      signature: decoded.payload.signature,
    });
    expect(lower(recovered)).toBe(lower(SIGNER.address));
  });

  it('rejects upto on v1 rather than routing it through the v2 handler', async () => {
    const server = seller({ x402Version: 1, accepts: [{ ...UPTO, amount: undefined, maxAmountRequired: '500000' }] });
    await rejects(buyer(server)(RESOURCE_URL), 'no_compatible_offer', /upto@v1/);
    expect(server.requests).toHaveLength(1);
  });

  it('rejects a v1 challenge whose price is malformed', async () => {
    const server = seller({ x402Version: 1, accepts: [{ ...V1_EXACT.accepts[0], maxAmountRequired: '-1' }] });
    await rejects(buyer(server)(RESOURCE_URL), 'invalid_challenge', /maxAmountRequired/);
  });
});

// -- offer selection ----------------------------------------------------------------------------

describe('offer selection', () => {
  it('rejects an unsupported scheme', async () => {
    const v1 = seller({ x402Version: 1, accepts: [{ ...V1_EXACT.accepts[0], scheme: 'subscription', maxAmountRequired: '1' }] });
    await rejects(buyer(v1)(RESOURCE_URL), 'no_compatible_offer', /subscription@v1/);
    const v2s = seller(v2({ ...EXACT_EIP3009, scheme: 'subscription' }));
    await rejects(buyer(v2s)(RESOURCE_URL), 'no_compatible_offer', /subscription@v2/);
  });

  it('rejects an unsupported exact@v2 transfer method', async () => {
    const server = seller(v2({ ...EXACT_EIP3009, extra: { assetTransferMethod: 'erc7710' } }));
    await rejects(buyer(server)(RESOURCE_URL), 'unsupported_transfer_method', /erc7710/);
  });

  it('rejects offers on another network or asset before signing', async () => {
    await rejects(buyer(seller(v2({ ...UPTO, network: 'eip155:1' })))(RESOURCE_URL), 'network_mismatch', /eip155:1/);
    await rejects(buyer(seller({ ...V1_EXACT, accepts: [{ ...V1_EXACT.accepts[0], network: 'eip155:723487' }] }))(RESOURCE_URL), 'network_mismatch');
    await rejects(buyer(seller(v2({ ...EXACT_EIP3009, asset: PAY_TO })))(RESOURCE_URL), 'asset_mismatch');
  });

  it('rejects an offer above maxPerRequest', async () => {
    const server = seller(v2(EXACT_EIP3009));
    await rejects(buyer(server, { maxPerRequest: { amount: '12999' } })(RESOURCE_URL), 'price_above_limit', /0\.013 USDC exceeds/);
    expect(server.requests).toHaveLength(1);
  });

  it('rejects unsupported protocol versions and empty challenges', async () => {
    await rejects(buyer(seller({ x402Version: 3, accepts: [EXACT_EIP3009] }))(RESOURCE_URL), 'invalid_challenge');
    await rejects(buyer(seller({ x402Version: 1, accepts: [] }))(RESOURCE_URL), 'invalid_challenge');
  });

  it('takes the first compatible offer in server order, like radius-cli, skipping incompatible ones', async () => {
    stubRpc();
    const challenge = { ...v2(EXACT_PERMIT2), accepts: [{ ...UPTO, network: 'eip155:1' }, { ...EXACT_PERMIT2, amount: '20000' }, EXACT_EIP3009] };
    const server = seller(challenge);
    const offers: PaymentOffer[] = [];
    await buyer(server, { onPaymentRequired: (o) => { offers.push(o); return true; } })(RESOURCE_URL);
    expect(offers[0]).toMatchObject({ amount: '20000', transferMethod: 'permit2' });
    expect(fromB64(server.requests[1].headers.get('payment-signature')!).accepted).toEqual({ ...EXACT_PERMIT2, amount: '20000' });
  });

  it('skips offers above maxPerRequest rather than ranking by amount (an upto amount is a ceiling, not a price)', async () => {
    stubRpc();
    const challenge = { ...v2(EXACT_PERMIT2), accepts: [UPTO, { ...EXACT_PERMIT2, amount: '20000' }, EXACT_EIP3009] };
    const server = seller(challenge);
    const offers: PaymentOffer[] = [];
    await buyer(server, { maxPerRequest: { amount: '20000' }, onPaymentRequired: (o) => { offers.push(o); return true; } })(RESOURCE_URL);
    expect(offers[0]).toMatchObject({ scheme: 'exact', amount: '20000' });
    await rejects(buyer(seller(challenge), { maxPerRequest: { amount: '12999' } })(RESOURCE_URL), 'price_above_limit', /up to 0\.5 USDC/);
  });

  it('rejects an offer whose payTo is not an address before any prompt', async () => {
    const offers: PaymentOffer[] = [];
    const server = seller(v2({ ...EXACT_EIP3009, payTo: 'notanaddress' }));
    await rejects(buyer(server, { onPaymentRequired: (o) => { offers.push(o); return true; } })(RESOURCE_URL), 'invalid_challenge', /payTo/);
    expect(offers).toHaveLength(0);
    expect(server.requests).toHaveLength(1);
  });

  it('caps the signing window at 600 s whatever the server asks for', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { decoded } = await pay(v2({ ...EXACT_EIP3009, maxTimeoutSeconds: 86_400 }));
    expect(Number(decoded.payload.authorization.validBefore)).toBeLessThanOrEqual(now + 600 + 1);
    const missing = await pay(v2({ ...EXACT_EIP3009, maxTimeoutSeconds: undefined }));
    expect(Number(missing.decoded.payload.authorization.validBefore)).toBeLessThanOrEqual(now + 600 + 1);
  });

  it('surfaces a 402 after payment as payment_rejected with the server response attached', async () => {
    const server = seller(v2(EXACT_EIP3009), () => new Response('{"detail":"nonce already used"}', { status: 402, headers: { 'PAYMENT-REQUIRED': b64({ ...v2(EXACT_EIP3009), error: 'insufficient_funds' }) } }));
    const err = await buyer(server)(RESOURCE_URL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RadiusPaymentError);
    expect((err as RadiusPaymentError).code).toBe('payment_rejected');
    const details = (err as RadiusPaymentError).details as PaymentRejectedDetails;
    expect(details.error).toBe('insufficient_funds');
    expect(details.response.status).toBe(402);
    expect(await details.response.text()).toBe('{"detail":"nonce already used"}');

    const bare = seller(v2(EXACT_EIP3009), () => new Response('nope', { status: 402 }));
    const bareErr = (await buyer(bare)(RESOURCE_URL).catch((e: unknown) => e)) as RadiusPaymentError;
    expect(bareErr.code).toBe('payment_rejected');
    expect(bareErr.message).toMatch(/no reason given/);
    expect(await (bareErr.details as PaymentRejectedDetails).response.text()).toBe('nope');
  });

  it('attaches the response and body to invalid_challenge', async () => {
    const server: MockServer = { requests: [], fetch: (async () => new Response('<html>garbage</html>', { status: 402 })) as typeof globalThis.fetch };
    const err = (await buyer(server)(RESOURCE_URL).catch((e: unknown) => e)) as RadiusPaymentError;
    expect(err.code).toBe('invalid_challenge');
    const details = err.details as InvalidChallengeDetails;
    expect(details.response.status).toBe(402);
    expect(details.body).toContain('garbage');
  });
});

// -- redirects before paying (real HTTP servers, so fetch itself follows them) -------------------

describe('a 402 behind a redirect', () => {
  type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
  const servers: Server[] = [];
  afterEach(() => { servers.splice(0).forEach((s) => s.close()); });

  /** Start a server; `seen` logs its requests, `route` answers them. */
  async function serve(route: (req: Seen, res: ServerResponse) => void) {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c)).on('end', () => {
        const r = { method: req.method!, url: req.url!, headers: req.headers, body };
        seen.push(r);
        route(r, res);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { seen, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }
  /** A paywall: 402 until a payment header arrives, then 200. */
  const paywall = (req: Seen, res: ServerResponse) => {
    if (req.headers['payment-signature']) return void res.writeHead(200).end('paid');
    res.writeHead(402, { 'PAYMENT-REQUIRED': b64(v2(EXACT_EIP3009)) }).end();
  };
  const redirector = (status: number, location: string) => (_req: Seen, res: ServerResponse) => void res.writeHead(status, { location }).end();
  const payer = (extra: Partial<RadiusFetchOptions> = {}) => createRadiusFetch({ network: NETWORK, signer: PK, maxPerRequest: { amount: '1000000' }, ...extra });

  it('is paid at the final URL, never at the redirector', async () => {
    const shop = await serve(paywall);
    const short = await serve(redirector(302, `${shop.origin}/final`));
    const res = await payer()(`${short.origin}/r`);
    expect([res.status, await res.text()]).toEqual([200, 'paid']);
    expect(short.seen.map((r) => [r.url, !!r.headers['payment-signature']])).toEqual([['/r', false]]);
    expect(shop.seen.map((r) => [r.url, !!r.headers['payment-signature']])).toEqual([['/final', false], ['/final', true]]);
  });

  it('leaves Authorization and Cookie behind on another origin', async () => {
    const shop = await serve(paywall);
    const short = await serve(redirector(302, `${shop.origin}/final`));
    await payer()(`${short.origin}/r`, { headers: { Authorization: 'Bearer s', Cookie: 'a=b', 'X-Api-Key': 'k' } });
    expect(short.seen[0].headers.authorization).toBe('Bearer s');
    expect(shop.seen).toHaveLength(2);
    for (const r of shop.seen) expect([r.headers.authorization, r.headers.cookie, r.headers['x-api-key']]).toEqual([undefined, undefined, 'k']);
  });

  it('replays the original method and body at the final URL', async () => {
    const shop = await serve(paywall);
    const short = await serve(redirector(307, `${shop.origin}/final`));
    await payer()(`${short.origin}/r`, { method: 'POST', body: '{"a":1}' });
    expect(shop.seen.map((r) => [r.method, r.body, !!r.headers['payment-signature']])).toEqual([['POST', '{"a":1}', false], ['POST', '{"a":1}', true]]);
  });

  it('pays a POST that a 302 turned into a GET as a POST (documented hazard)', async () => {
    const shop = await serve(paywall);
    const short = await serve(redirector(302, `${shop.origin}/final`));
    await payer()(`${short.origin}/r`, { method: 'POST', body: '{"a":1}' });
    expect(shop.seen.map((r) => [r.method, r.body, !!r.headers['payment-signature']])).toEqual([['GET', '', false], ['POST', '{"a":1}', true]]);
  });

  it('pays a redirected HEAD and GET', async () => {
    for (const method of ['HEAD', 'GET']) {
      const shop = await serve(paywall);
      const short = await serve(redirector(302, `${shop.origin}/final`));
      expect((await payer()(`${short.origin}/r`, { method })).status).toBe(200);
      expect(shop.seen.map((r) => [r.method, !!r.headers['payment-signature']])).toEqual([[method, false], [method, true]]);
    }
  });

  /** A paywall that, once paid, redirects (with the receipt) to `content`, which wants the token and no payment header. */
  const tokenShop = (contentOrigin: () => string, status = 302) => async (req: Seen, res: ServerResponse) => {
    const receipt = b64({ success: true, transaction: '0xabc', network: NETWORK_ID, payer: SIGNER.address });
    if (req.url.startsWith('/content')) return void (req.url.endsWith('token=abc') ? res.writeHead(200).end('content') : res.writeHead(403).end());
    if (req.headers['payment-signature']) return void res.writeHead(status, { location: `${contentOrigin()}/content?token=abc`, 'PAYMENT-RESPONSE': receipt }).end();
    res.writeHead(402, { 'PAYMENT-REQUIRED': b64(v2(EXACT_EIP3009)) }).end();
  };

  it('follows a redirect after payment and takes the receipt from it', async () => {
    const paid: PaymentReceipt[] = [];
    let origin = '';
    const shop = await serve(tokenShop(() => origin));
    origin = shop.origin;
    const res = await payer({ onPaid: (r) => void paid.push(r) })(`${shop.origin}/pay`, { headers: { 'X-Api-Key': 'k' } });
    expect([res.status, await res.text()]).toEqual([200, 'content']);
    expect(getPaymentReceipt(res)).toMatchObject({ success: true, transaction: '0xabc' });
    expect(paid).toHaveLength(1);
    const followUp = shop.seen.at(-1)!;
    expect([followUp.url, followUp.headers['payment-signature'], followUp.headers['x-api-key']]).toEqual(['/content?token=abc', undefined, 'k']);
  });

  it('follows a redirect after payment by fetch\'s rules: 303 and a 301/302 POST become GET, 307/308 repeat the request', async () => {
    const cases = [
      [303, 'POST', 'GET', ''], [303, 'PUT', 'GET', ''], [302, 'POST', 'GET', ''], [301, 'POST', 'GET', ''],
      [302, 'PUT', 'PUT', '{"a":1}'], [301, 'DELETE', 'DELETE', '{"a":1}'], [307, 'POST', 'POST', '{"a":1}'], [308, 'PUT', 'PUT', '{"a":1}'],
      [303, 'HEAD', 'HEAD', ''], [302, 'HEAD', 'HEAD', ''],
    ] as const;
    for (const [status, method, expected, expectedBody] of cases) {
      const target = await serve((_req, res) => void res.writeHead(200).end('content'));
      const shop = await serve(tokenShop(() => target.origin, status));
      await payer()(`${shop.origin}/pay`, { method, body: method === 'HEAD' ? undefined : '{"a":1}', headers: { 'content-type': 'application/json' } });
      const hop = target.seen[0];
      expect([status, method, hop.method, hop.body, hop.headers['payment-signature']]).toEqual([status, method, expected, expectedBody, undefined]);
      expect(hop.headers['content-type']).toBe(expected === 'GET' ? undefined : 'application/json'); // body headers go with the body
    }
  });

  it('sends the follow-up to another origin without the payment header, Authorization or Cookie', async () => {
    const cdn = await serve(tokenShop(() => ''));
    const shop = await serve(tokenShop(() => cdn.origin));
    const res = await payer()(`${shop.origin}/pay`, { headers: { Authorization: 'Bearer s', Cookie: 'a=b' } });
    expect(await res.text()).toBe('content');
    expect(cdn.seen).toHaveLength(1);
    expect([cdn.seen[0].headers['payment-signature'], cdn.seen[0].headers.authorization, cdn.seen[0].headers.cookie]).toEqual([undefined, undefined, undefined]);
  });
});

describe('passthrough', () => {
  it('sends a request that already carries a payment header straight through', async () => {
    const server = seller(v2(EXACT_EIP3009));
    const res = await buyer(server)(RESOURCE_URL, { headers: { 'X-PAYMENT': 'presigned' } });
    expect(res.status).toBe(200);
    expect(server.requests).toHaveLength(1);
  });
});

// -- sponsored approvals pass the approval gate (ENG-2389) -----------------------------------

describe('a sponsored raw approve is an allowance change, so it is gated', () => {
  const ERC20_SPONSOR = { erc20ApprovalGasSponsoring: { version: '1' } };

  it("permit2Approval: 'never' refuses a sponsored unlimited approve instead of signing it", async () => {
    stubRpc({ allowance: 0n });
    const server = seller(v2(UPTO, ERC20_SPONSOR));
    await rejects(buyer(server, { permit2Approval: 'never' })(RESOURCE_URL), 'approval_required', /sponsors an approval/);
    expect(server.requests).toHaveLength(1);
  });

  it('onApprovalRequired sees the sponsored approval (unlimited) and can decline it', async () => {
    stubRpc({ allowance: 0n });
    const seen: ApprovalRequest[] = [];
    const server = seller(v2(UPTO, ERC20_SPONSOR));
    await rejects(buyer(server, { onApprovalRequired: (r) => { seen.push(r); return false; } })(RESOURCE_URL), 'declined');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ reason: 'payment', sponsored: 'erc20Approval', amount: maxUint256, currentAllowance: 0n });
    expect(server.requests).toHaveLength(1);
  });

  it('a failed allowance read counts as no allowance: the raw approve is gated, not signed', async () => {
    stubRpc({ allowanceError: true });
    const server = seller(v2(UPTO, ERC20_SPONSOR));
    await rejects(buyer(server, { permit2Approval: 'never' })(RESOURCE_URL), 'approval_required', /sponsors an approval/);
    expect(server.requests).toHaveLength(1);
  });

  it('an EIP-2612 sponsorship is part of the payment: not gated, even with permit2Approval: never', async () => {
    stubRpc({ allowance: 0n });
    const onApprovalRequired = vi.fn(() => false);
    const { decoded } = await pay(v2(UPTO, { eip2612GasSponsoring: { version: '1' } }), { permit2Approval: 'never', onApprovalRequired });
    expect(onApprovalRequired).not.toHaveBeenCalled();
    expect(decoded.extensions.eip2612GasSponsoring.info).toMatchObject({ amount: '500000' });
  });

  it('with the permit available, the raw approve is never handed to the scheme', async () => {
    stubRpc({ allowance: 0n });
    const { decoded } = await pay(v2(UPTO, { eip2612GasSponsoring: { version: '1' }, ...ERC20_SPONSOR }));
    expect(decoded.extensions.eip2612GasSponsoring.info).toBeDefined();
    expect(decoded.extensions?.erc20ApprovalGasSponsoring?.info).toBeUndefined();
  });

  it('with enough allowance no raw approve is handed to the scheme', async () => {
    stubRpc({ allowance: 10n ** 12n });
    const { decoded } = await pay(v2(UPTO, ERC20_SPONSOR));
    expect(decoded.payload.permit2Authorization).toBeDefined();
    expect(decoded.extensions?.erc20ApprovalGasSponsoring?.info).toBeUndefined();
  });
});
