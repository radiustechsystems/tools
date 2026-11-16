/**
 * Paying and charging on several networks: Radius plus Base Sepolia. Nothing touches a chain or a
 * real facilitator: sellers are mock fetches, facilitator HTTP is stubbed on the global fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { createRadiusFetch, RadiusPaymentError, type PaymentOffer, type RadiusFetchOptions } from '../src/client/index.js';
import { baseChain, baseMainnet, baseSepolia, definePaymentNetwork, radiusTestnet, SBC, USDC_BASE, USDC_BASE_SEPOLIA } from '../src/networks.js';
import { getPaymentReceipt } from '../src/receipt.js';
import { radiusPayments, RadiusServer } from '../src/server/index.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const SIGNER = privateKeyToAccount(PK);
const PAY_TO = '0x000000000000000000000000000000000000dEaD' as Address;
const URL_ = 'https://api.example.com/r';
const TX = `0x${'ab'.repeat(32)}`;

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

const radiusOffer = (amount = '1000') => ({
  scheme: 'exact',
  network: radiusTestnet.network,
  asset: SBC.address,
  payTo: PAY_TO,
  amount,
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: 'eip3009', name: SBC.name, version: SBC.version },
});
const baseOffer = (amount = '1000') => ({
  scheme: 'exact',
  network: baseSepolia.network,
  asset: USDC_BASE_SEPOLIA.address,
  payTo: PAY_TO,
  amount,
  maxTimeoutSeconds: 60,
  extra: { name: USDC_BASE_SEPOLIA.name, version: USDC_BASE_SEPOLIA.version },
});

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
const fromB64 = (s: string) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

function seller(challenge: { x402Version: number }, paid: () => Response = () => Response.json({ ok: true })) {
  const requests: Request[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req);
    if (req.headers.has('payment-signature') || req.headers.has('x-payment')) return paid();
    if (challenge.x402Version === 2) return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': b64(challenge) } });
    return Response.json(challenge, { status: 402 });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const v2 = (...accepts: unknown[]) => ({ x402Version: 2, resource: { url: URL_ }, accepts });

async function pay(challenge: { x402Version: number }, options: Partial<RadiusFetchOptions>, paid?: () => Response) {
  const server = seller(challenge, paid);
  const offers: PaymentOffer[] = [];
  const res = await createRadiusFetch({
    networks: ['testnet', 'base-sepolia'],
    signer: PK,
    maxPerRequest: '$0.01',
    fetch: server.fetch,
    onPaymentRequired: (o) => {
      offers.push(o);
      return true;
    },
    ...options,
  })(URL_);
  const header = server.requests[1]?.headers.get('payment-signature') ?? server.requests[1]?.headers.get('x-payment');
  return { res, offer: offers[0], decoded: header ? fromB64(header) : undefined };
}

const rejects = (p: Promise<unknown>, code: string, message?: RegExp) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof RadiusPaymentError && e.code === code && (!message || message.test(e.message)));

afterEach(() => vi.restoreAllMocks());

/** Payer balances per RPC host, served to `balanceOf` calls; a missing host fails the read. */
let balances: Record<string, bigint | undefined>;
const balanceReads: string[] = [];

describe('createRadiusFetch on several networks', () => {
  beforeEach(() => {
    balances = { [new URL(radiusTestnet.rpcUrl).host]: 10n ** 18n, [new URL(baseSepolia.rpcUrl).host]: 10n ** 6n };
    balanceReads.length = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const host = new URL(input instanceof Request ? input.url : String(input)).host;
      const { id, method } = JSON.parse(String(init?.body));
      if (method !== 'eth_call') throw new Error(`unexpected RPC ${method}`);
      balanceReads.push(host);
      const balance = balances[host];
      if (balance === undefined) return Response.json({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } });
      return Response.json({ jsonrpc: '2.0', id, result: `0x${balance.toString(16).padStart(64, '0')}` });
    });
  });

  it('pays a Base offer in USDC, signed for the Base Sepolia USDC domain', async () => {
    const { offer, decoded } = await pay(v2(baseOffer()), {});
    expect(offer.network).toBe(baseSepolia);
    expect(offer).toMatchObject({ amount: '1000', amountFormatted: '0.001 USDC', transferMethod: 'eip3009', asset: USDC_BASE_SEPOLIA.address });
    const { authorization, signature } = decoded.payload;
    const signer = await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA.address },
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
      signature,
    });
    expect(signer).toBe(SIGNER.address);
    expect(decoded.accepted).toEqual(baseOffer());
  });

  it("prefers the client's network order, whatever order the server lists them in", async () => {
    expect((await pay(v2(baseOffer(), radiusOffer()), {})).offer.network).toBe(radiusTestnet);
    expect((await pay(v2(radiusOffer(), baseOffer()), { networks: ['base-sepolia', 'testnet'] })).offer.network).toBe(baseSepolia);
  });

  it('pays where the wallet is funded when the preferred network is not', async () => {
    balances[new URL(radiusTestnet.rpcUrl).host] = 0n;
    const { offer, decoded } = await pay(v2(radiusOffer(), baseOffer()), {});
    expect(offer.network).toBe(baseSepolia);
    expect(decoded.accepted).toEqual(baseOffer());
    expect(balanceReads.sort()).toEqual([new URL(baseSepolia.rpcUrl).host, new URL(radiusTestnet.rpcUrl).host].sort());
  });

  it('keeps preference order among funded networks, and reads no balance with one candidate network', async () => {
    expect((await pay(v2(radiusOffer(), baseOffer()), {})).offer.network).toBe(radiusTestnet);
    balanceReads.length = 0;
    expect((await pay(v2(baseOffer()), {})).offer.network).toBe(baseSepolia);
    expect(balanceReads).toEqual([]);
  });

  it('treats a balance it could not read as possibly funded, after funded networks', async () => {
    balances[new URL(radiusTestnet.rpcUrl).host] = undefined;
    expect((await pay(v2(radiusOffer(), baseOffer()), {})).offer.network).toBe(baseSepolia);
    balances[new URL(baseSepolia.rpcUrl).host] = 0n;
    expect((await pay(v2(radiusOffer(), baseOffer()), {})).offer.network).toBe(radiusTestnet);
  });

  it('refuses before signing when no candidate network is funded, naming each', async () => {
    balances = { [new URL(radiusTestnet.rpcUrl).host]: 0n, [new URL(baseSepolia.rpcUrl).host]: 999n };
    const server = seller(v2(radiusOffer(), baseOffer()));
    const payFetch = createRadiusFetch({ networks: ['testnet', 'base-sepolia'], signer: PK, maxPerRequest: '$0.01', fetch: server.fetch });
    await rejects(payFetch(URL_), 'insufficient_balance', /need 0\.001 SBC on radius-testnet \(have 0 SBC\) or 0\.001 USDC on base-sepolia \(have 0\.000999 USDC\)/);
    expect(server.requests).toHaveLength(1);
  });

  it('keeps pure preference order with preferFunded: false', async () => {
    balances[new URL(radiusTestnet.rpcUrl).host] = 0n;
    expect((await pay(v2(radiusOffer(), baseOffer()), { preferFunded: false })).offer.network).toBe(radiusTestnet);
    expect(balanceReads).toEqual([]);
  });

  it('falls through to the next network when the preferred one is over the cap', async () => {
    const { offer } = await pay(v2(radiusOffer('20000'), baseOffer('5000')), {});
    expect(offer).toMatchObject({ network: baseSepolia, amount: '5000' });
    await rejects(pay(v2(radiusOffer('20000'), baseOffer('20000')), {}), 'price_above_limit', /0\.02 SBC exceeds maxPerRequest 0\.01 SBC/);
  });

  it('converts a USD cap for each network and applies an atomic cap to each as-is', () => {
    const usd = createRadiusFetch({ networks: ['testnet', 'base-sepolia'], signer: PK, maxPerRequest: '$0.05' });
    expect(usd.on('base-sepolia').maxPerRequest).toBe(50_000n);
    expect(usd.maxPerRequest).toBe(50_000n);
    const atomic = createRadiusFetch({ networks: ['testnet', 'base-sepolia'], signer: PK, maxPerRequest: { amount: '7' } });
    expect(atomic.on(baseSepolia).maxPerRequest).toBe(7n);
  });

  it('pays an x402 v1 challenge that names Base by its v1 network name', async () => {
    const v1 = {
      x402Version: 1,
      accepts: [{ ...baseOffer(), network: 'base-sepolia', amount: undefined, maxAmountRequired: '1000', resource: URL_, description: 'd', mimeType: 'application/json' }],
    };
    const { offer, decoded } = await pay(v1, {});
    expect(offer.network).toBe(baseSepolia);
    expect(decoded).toMatchObject({ x402Version: 1, scheme: 'exact', network: 'base-sepolia' });
    const { authorization, signature } = decoded.payload;
    const signer = await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA.address },
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
      signature,
    });
    expect(signer).toBe(SIGNER.address);
  });

  it('decodes the receipt against the network that was paid', async () => {
    const paid = () => Response.json({ ok: true }, { headers: { 'PAYMENT-RESPONSE': b64({ success: true, transaction: TX, network: baseSepolia.network, payer: SIGNER.address }) } });
    let receipt: { explorerUrl?: string } | undefined;
    await pay(v2(baseOffer()), { onPaid: (r) => void (receipt = r) }, paid);
    expect(receipt?.explorerUrl).toBe(`https://sepolia.basescan.org/tx/${TX}`);
  });

  it('names every enabled network when nothing matches', async () => {
    await rejects(pay(v2({ ...baseOffer(), network: 'eip155:1' }), {}), 'network_mismatch', /eip155:72344 \(radius-testnet\), eip155:84532 \(base-sepolia\)/);
    await rejects(pay(v2({ ...baseOffer(), asset: SBC.address }), {}), 'asset_mismatch', /USDC \(0x036C/);
  });

  it('only pays on networks it was given', async () => {
    await rejects(pay(v2(baseOffer()), { networks: undefined, network: 'testnet' }), 'network_mismatch');
  });

  it('exposes wallet helpers per network', () => {
    const payFetch = createRadiusFetch({ networks: ['testnet', 'base-sepolia'], signer: PK, maxPerRequest: '$0.01' });
    expect(payFetch.network).toBe(radiusTestnet);
    expect(payFetch.networks).toEqual([radiusTestnet, baseSepolia]);
    expect(payFetch.on('base-sepolia').network).toBe(baseSepolia);
    expect(payFetch.on('eip155:84532').network).toBe(baseSepolia);
    expect(payFetch.on(radiusTestnet).network).toBe(radiusTestnet);
    expect(payFetch.on('testnet').network).toBe(radiusTestnet);
    expect(payFetch.on('radius-testnet').network).toBe(radiusTestnet);
    expect(createRadiusFetch({ signer: PK, maxPerRequest: '$0.01' }).on('mainnet').network.name).toBe('radius');
    expect(() => payFetch.on('base')).toThrow(/base is not one of this client's networks/);
    expect(() => payFetch.on(baseMainnet)).toThrow(/not one of this client's networks/);
  });

  it('applies top-level overrides to the first network only', () => {
    const payFetch = createRadiusFetch({ networks: ['testnet', 'base-sepolia'], rpcUrl: 'https://rpc.example', signer: PK, maxPerRequest: '$0.01' });
    expect(payFetch.network.rpcUrl).toBe('https://rpc.example');
    expect(payFetch.on('base-sepolia').network.rpcUrl).toBe('https://sepolia.base.org');
  });

  it('rejects ambiguous or duplicate network configuration', () => {
    const base = { signer: PK, maxPerRequest: '$0.01' } as const;
    expect(() => createRadiusFetch({ ...base, network: 'testnet', networks: ['base'] })).toThrow(/network or networks, not both/);
    expect(() => createRadiusFetch({ ...base, networks: [] })).toThrow(/networks is empty/);
    expect(() => createRadiusFetch({ ...base, networks: ['testnet', 'radius-testnet'] })).toThrow(/listed twice/);
  });

  it('refuses an injected wallet for networks other than the one it is connected to', async () => {
    const { createWalletClient, http } = await import('viem');
    const injected = createWalletClient({ account: SIGNER.address, chain: radiusTestnet.chain, transport: http('http://127.0.0.1:1') });
    expect(() => createRadiusFetch({ networks: ['testnet', 'base-sepolia'], signer: injected, maxPerRequest: '$0.01' })).toThrow(/injected wallet signs only for the chain it is connected to \(72344\); base-sepolia/);
    expect(createRadiusFetch({ network: 'testnet', signer: injected, maxPerRequest: '$0.01' }).network).toBe(radiusTestnet);
  });

  it('sends transactions on a WalletClient signer only on the chain it is connected to', async () => {
    const { createWalletClient, http } = await import('viem');
    const wc = createWalletClient({ account: SIGNER, chain: radiusTestnet.chain, transport: http('http://127.0.0.1:1') });
    const payFetch = createRadiusFetch({ networks: ['testnet', 'base-sepolia'], signer: wc, maxPerRequest: '$0.01' });
    await expect(payFetch.on('base-sepolia').send(PAY_TO, '0.01')).rejects.toThrow(/connected to chain 72344, not base-sepolia/);
  });
});

// -- seller -------------------------------------------------------------------------------------

/** Base Sepolia's default facilitator (the Radius testnet one). */
const BASE_SEPOLIA_FACILITATOR = baseSepolia.facilitatorUrl!;
/** Another facilitator, named explicitly for Base Sepolia where the test needs one distinct from Radius testnet's. */
const OTHER_FACILITATOR = 'https://other-facilitator.example';

/** Stub the Base Sepolia facilitator: `/supported` lists exact without a transfer method. */
function mockBaseFacilitator(extensions: string[] = []) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (!url.startsWith(BASE_SEPOLIA_FACILITATOR)) throw new Error(`unexpected fetch ${url}`);
    if (url.endsWith('/supported')) return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: baseSepolia.network }], extensions, signers: {} });
    if (url.endsWith('/verify')) return Response.json({ isValid: true, payer: SIGNER.address });
    if (url.endsWith('/settle')) return Response.json({ success: true, transaction: TX, network: baseSepolia.network, payer: SIGNER.address });
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

function twoNetworkSeller(onSettled?: (r: { network: string; explorerUrl?: string }) => void) {
  return radiusPayments({
    networks: [{ network: 'testnet', facilitator: { live: false } }, 'base-sepolia'],
    payTo: PAY_TO,
    routes: { 'GET /api/lookup': '$0.001' },
    onSettled,
  });
}

describe('radiusPayments on several networks', () => {
  it('offers one payment option per network, in order, each in its own asset and transfer method', async () => {
    mockBaseFacilitator();
    const res = await twoNetworkSeller()(new Request('http://seller.test/api/lookup'), () => Response.json({ leaked: true }));
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get('payment-required')!);
    expect(pr.accepts).toHaveLength(2);
    expect(pr.accepts[0]).toMatchObject({ network: 'eip155:72344', asset: SBC.address, amount: '1000', payTo: PAY_TO, extra: { assetTransferMethod: 'eip3009', name: 'Stable Coin', version: '1' } });
    expect(pr.accepts[1]).toMatchObject({ network: 'eip155:84532', asset: USDC_BASE_SEPOLIA.address, amount: '1000', payTo: PAY_TO, extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' } });
    // Radius's facilitator sponsors Permit2 approvals; Base Sepolia's does not, and the declaration stays.
    expect(pr.extensions).toHaveProperty('eip2612GasSponsoring');
  });

  it("settles a Base payment through that network's facilitator and reports it on that network", async () => {
    const calls = mockBaseFacilitator();
    const settled: { network: string; explorerUrl?: string }[] = [];
    const app = twoNetworkSeller((r) => settled.push(r)).wrap((_req, payment) => Response.json({ payment }));
    const pr = decodePaymentRequiredHeader((await app(new Request('http://seller.test/api/lookup'))).headers.get('payment-required')!);
    const accepted = pr.accepts[1];
    const { paymentFlow: _pf, ...extra } = accepted.extra as Record<string, unknown>;
    const header = encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: { ...accepted, extra }, payload: { signature: '0xsig', authorization: {} } });
    const res = await app(new Request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': header } }));
    expect(res.status).toBe(200);
    expect(calls.filter((u) => u.endsWith('/settle'))).toEqual([`${BASE_SEPOLIA_FACILITATOR}/settle`]);
    expect(getPaymentReceipt(res, baseSepolia)).toMatchObject({ success: true, network: 'eip155:84532' });
    expect((await res.json()).payment).toMatchObject({ network: 'eip155:84532', explorerUrl: `https://sepolia.basescan.org/tx/${TX}` });
    expect(settled).toEqual([expect.objectContaining({ network: 'eip155:84532', explorerUrl: `https://sepolia.basescan.org/tx/${TX}` })]);
  });

  it('answers 502 and retries when a facilitator lists nothing for its network, instead of caching a partial setup', async () => {
    let down = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/supported')) return down ? new Response('bad gateway', { status: 502 }) : Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: baseSepolia.network }], extensions: [], signers: {} });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seller = twoNetworkSeller();
    const first = await seller(new Request('http://seller.test/api/lookup'), () => Response.json({}));
    expect(first.status).toBe(502);
    expect(await first.json()).toMatchObject({ error: 'facilitator_error', message: expect.stringMatching(/base-sepolia/) });
    down = false;
    const second = await seller(new Request('http://seller.test/api/lookup'), () => Response.json({}));
    expect(second.status).toBe(402);
    expect(decodePaymentRequiredHeader(second.headers.get('payment-required')!).accepts).toHaveLength(2);
  });

  it("routes each network to its own facilitator even when another one lists it too", async () => {
    // The facilitator named for Base Sepolia (listed first) also claims Radius testnet.
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url === `${OTHER_FACILITATOR}/supported`) {
        return Response.json({ kinds: [baseSepolia.network, radiusTestnet.network].map((network) => ({ x402Version: 2, scheme: 'exact', network, extra: { assetTransferMethod: 'eip3009' } })), extensions: [], signers: {} });
      }
      if (url.endsWith('/verify')) return Response.json({ isValid: true, payer: SIGNER.address });
      if (url.endsWith('/settle')) return Response.json({ success: true, transaction: TX, network: radiusTestnet.network, payer: SIGNER.address });
      throw new Error(`unexpected fetch ${url}`);
    });
    const app = radiusPayments({ networks: [{ network: 'base-sepolia', facilitator: { url: OTHER_FACILITATOR } }, { network: 'testnet', facilitator: { live: false } }], payTo: PAY_TO, routes: { 'GET /api/lookup': '$0.001' } }).wrap(() => Response.json({}));
    const pr = decodePaymentRequiredHeader((await app(new Request('http://seller.test/api/lookup'))).headers.get('payment-required')!);
    const accepted = pr.accepts.find((a) => a.network === radiusTestnet.network)!;
    const { paymentFlow: _pf, ...extra } = accepted.extra as Record<string, unknown>;
    const header = encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: { ...accepted, extra }, payload: { signature: '0xsig', authorization: {} } });
    expect((await app(new Request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': header } }))).status).toBe(200);
    expect(calls.filter((u) => u.endsWith('/settle'))).toEqual([`${radiusTestnet.facilitatorUrl}/settle`]);
  });

  it('settles Base through the Radius facilitator by default and requires one for a custom network', () => {
    expect(new RadiusServer({ networks: ['testnet', 'base'] }).networks.map((n) => n.name)).toEqual(['radius-testnet', 'base']);
    expect(new RadiusServer({ networks: ['testnet', { network: 'base', facilitator: { url: 'https://facilitator.example' } }] }).networks.map((n) => n.name)).toEqual(['radius-testnet', 'base']);
    const custom = definePaymentNetwork({ chain: baseChain, asset: USDC_BASE, name: 'custom-base' });
    expect(() => new RadiusServer({ networks: ['testnet', custom] })).toThrow(/no default facilitator for custom-base/);
  });

  it('keeps the built-in /supported answer to Radius networks', () => {
    expect(() => new RadiusServer({ network: 'base-sepolia', facilitator: { live: false } })).toThrow(/only available on Radius networks/);
  });

  it('rejects a price that names one asset for several networks', () => {
    const server = new RadiusServer({ networks: [{ network: 'testnet', facilitator: { live: false } }, 'base-sepolia'] });
    expect(() => server.routes({ payTo: PAY_TO, routes: { 'GET /x': { price: { amount: '1', asset: SBC.address } } } })).toThrow(/cannot apply to several networks/);
    expect(server.routes({ payTo: PAY_TO, routes: { 'GET /x': { price: { amount: '1' } } } })['GET /x'].accepts).toHaveLength(2);
  });

  it('rejects ambiguous or duplicate network configuration', () => {
    expect(() => new RadiusServer({ network: 'testnet', networks: ['base-sepolia'] })).toThrow(/network or networks, not both/);
    expect(() => new RadiusServer({ networks: [] })).toThrow(/networks is empty/);
    expect(() => new RadiusServer({ networks: ['base-sepolia', 'base-sepolia'] })).toThrow(/listed twice/);
  });
});
