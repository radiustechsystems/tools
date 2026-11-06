import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { radiusPayments, type RadiusPaymentVariables } from '../src/hono/index.js';
import { getPaymentReceipt } from '../src/receipt.js';

const PAY_TO = '0x1eF420190c299D4d133fE9227F780D7d5cE91BeE';

function makeApp(opts: Partial<Parameters<typeof radiusPayments>[0]> = {}) {
  const app = new Hono<{ Variables: RadiusPaymentVariables }>();
  app.use(
    radiusPayments({
      network: 'testnet',
      payTo: PAY_TO,
      facilitator: { live: false },
      routes: {
        'GET /api/lookup': { price: '$0.001', description: 'Lookup' },
        'POST /api/query': '0.01',
        'GET /api/atomic': { price: { amount: '42' } },
      },
      ...opts,
    }),
  );
  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/api/lookup', (c) => c.json({ data: 'secret', payment: c.get('radiusPayment') }));
  app.post('/api/query', (c) => c.json({ data: 'posted' }));
  app.get('/api/atomic', (c) => c.json({ data: 'atomic' }));
  return app;
}

afterEach(() => vi.restoreAllMocks());

async function payloadFor(app: Hono<any>) {
  const challenge = await app.request('http://seller.test/api/lookup');
  const pr = decodePaymentRequiredHeader(challenge.headers.get('payment-required')!);
  const accepted = pr.accepts[0];
  // Echo only the fields a minimal client (e.g. radius-cli) sends back.
  const { paymentFlow: _pf, ...extra } = accepted.extra as Record<string, unknown>;
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: pr.resource,
    accepted: { ...accepted, extra },
    payload: { signature: '0xsig', permit2Authorization: {} },
  });
}

describe('radiusPayments 402 challenge', () => {
  it('leaves unprotected routes alone', async () => {
    const res = await makeApp().request('/health');
    expect(res.status).toBe(200);
  });

  it('returns a standard x402 v2 challenge for SBC via EIP-3009 (listed first by the facilitator), with no gas-sponsoring declaration', async () => {
    const res = await makeApp().request('http://seller.test/api/lookup?q=1');
    expect(res.status).toBe(402);
    const header = res.headers.get('payment-required');
    expect(header).toBeTruthy();
    const pr = decodePaymentRequiredHeader(header!);
    expect(pr.x402Version).toBe(2);
    expect(pr.resource.url).toBe('http://seller.test/api/lookup?q=1');
    expect(pr.resource.description).toBe('Lookup');
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:72344',
      amount: '1000',
      asset: '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb',
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'eip3009', name: 'Stable Coin', version: '1', paymentFlow: 'upfront' },
    });
    expect(pr.extensions).toBeUndefined();
  });

  it('supports shorthand and atomic prices, and settle:"after" omits paymentFlow', async () => {
    const post = await makeApp().request('/api/query', { method: 'POST' });
    expect(decodePaymentRequiredHeader(post.headers.get('payment-required')!).accepts[0].amount).toBe('10000');
    const atomic = await makeApp().request('/api/atomic');
    expect(decodePaymentRequiredHeader(atomic.headers.get('payment-required')!).accepts[0].amount).toBe('42');
    const after = await makeApp({ settle: 'after' }).request('/api/lookup');
    expect(decodePaymentRequiredHeader(after.headers.get('payment-required')!).accepts[0].extra).not.toHaveProperty('paymentFlow');
  });

  it('resolves payTo dynamically from the Hono context', async () => {
    const app = new Hono<{ Bindings: { PAY_TO: string } }>();
    app.use(radiusPayments({ network: 'testnet', payTo: (c) => c.env.PAY_TO as `0x${string}`, facilitator: { live: false }, routes: { 'GET /p': '$1' } }));
    app.get('/p', (c) => c.text('x'));
    const res = await app.request('/p', {}, { PAY_TO: PAY_TO });
    expect(decodePaymentRequiredHeader(res.headers.get('payment-required')!).accepts[0].payTo).toBe(PAY_TO);
  });
});

describe('radiusPayments facilitator configuration', () => {
  it('fetches /supported lazily on the first paid request by default (live), never at construction', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.endsWith('/supported')) {
        return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:72344', extra: { assetTransferMethod: 'permit2', name: 'Custom Name', version: '9' } }], extensions: ['eip2612GasSponsoring'], signers: {} });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const app = new Hono();
    app.use(radiusPayments({ network: 'testnet', payTo: PAY_TO, routes: { 'GET /p': '$1' } }));
    app.get('/p', (c) => c.text('x'));
    app.get('/free', (c) => c.text('free'));
    expect(calls).toHaveLength(0);
    await app.request('/free');
    expect(calls).toHaveLength(0);
    const res = await app.request('/p');
    await app.request('/p');
    expect(calls).toEqual(['https://facilitator.testnet.radiustech.xyz/supported']);
    // The live answer, not the built-in one, shapes the challenge.
    expect(decodePaymentRequiredHeader(res.headers.get('payment-required')!).accepts[0].extra).toMatchObject({ name: 'Custom Name', version: '9' });
  });

  it('advertises eip3009 when the facilitator lists it first (SBC with EIP-3009)', async () => {
    const kinds = ['eip3009', 'permit2'].map((assetTransferMethod) => ({ x402Version: 2, scheme: 'exact', network: 'eip155:72344', extra: { assetTransferMethod, name: 'Stable Coin', version: '1' } }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ kinds, extensions: ['eip2612GasSponsoring'], signers: {} }));
    const app = new Hono();
    app.use(radiusPayments({ network: 'testnet', payTo: PAY_TO, routes: { 'GET /p': '$1' } }));
    app.get('/p', (c) => c.text('x'));
    const res = await app.request('/p');
    expect(res.status).toBe(402);
    expect(decodePaymentRequiredHeader(res.headers.get('payment-required')!).accepts[0].extra).toMatchObject({ assetTransferMethod: 'eip3009', name: 'Stable Coin', version: '1' });
  });

  it('declares gas sponsoring on a Permit2 offer when the facilitator supports it', async () => {
    const kinds = [{ x402Version: 2, scheme: 'exact', network: 'eip155:72344', extra: { assetTransferMethod: 'permit2', name: 'Stable Coin', version: '1' } }];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ kinds, extensions: ['eip2612GasSponsoring'], signers: {} }));
    const app = new Hono();
    app.use(radiusPayments({ network: 'testnet', payTo: PAY_TO, routes: { 'GET /p': '$1' } }));
    app.get('/p', (c) => c.text('x'));
    const pr = decodePaymentRequiredHeader((await app.request('/p')).headers.get('payment-required')!);
    expect(pr.accepts[0].extra).toMatchObject({ assetTransferMethod: 'permit2' });
    expect(pr.extensions).toHaveProperty('eip2612GasSponsoring');
  });

  it('never declares gas sponsoring on EIP-3009 offers, even when the facilitator supports it or it is forced', async () => {
    const kinds = ['eip3009', 'permit2'].map((assetTransferMethod) => ({ x402Version: 2, scheme: 'exact', network: 'eip155:72344', extra: { assetTransferMethod, name: 'Stable Coin', version: '1' } }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ kinds, extensions: ['eip2612GasSponsoring'], signers: {} }));
    for (const gasSponsoring of ['auto', true] as const) {
      const app = new Hono();
      app.use(radiusPayments({ network: 'testnet', payTo: PAY_TO, gasSponsoring, routes: { 'GET /p': '$1' } }));
      app.get('/p', (c) => c.text('x'));
      const pr = decodePaymentRequiredHeader((await app.request('/p')).headers.get('payment-required')!);
      expect(pr.accepts[0].extra).toMatchObject({ assetTransferMethod: 'eip3009' });
      expect(pr.extensions).toBeUndefined();
    }
  });

  it('declares gas sponsoring on Permit2 offers only when the facilitator supports it (or when forced)', async () => {
    const supportedWithout = { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:72344', extra: { assetTransferMethod: 'permit2', name: 'Stable Coin', version: '1' } }], extensions: [], signers: {} };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(supportedWithout));
    const build = (gasSponsoring?: 'auto' | boolean) => {
      const app = new Hono();
      app.use(radiusPayments({ network: 'testnet', payTo: PAY_TO, gasSponsoring, routes: { 'GET /p': '$1' } }));
      app.get('/p', (c) => c.text('x'));
      return app;
    };
    const auto = decodePaymentRequiredHeader((await build().request('/p')).headers.get('payment-required')!);
    expect(auto.extensions).toBeUndefined();
    const forced = decodePaymentRequiredHeader((await build(true).request('/p')).headers.get('payment-required')!);
    expect(forced.extensions).toHaveProperty('eip2612GasSponsoring');
    const off = decodePaymentRequiredHeader((await build(false).request('/p')).headers.get('payment-required')!);
    expect(off.extensions).toBeUndefined();
  });

  it('uses a custom facilitator URL and api key', async () => {
    const calls: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      calls.push(req);
      return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:72344', extra: { assetTransferMethod: 'permit2', name: 'Stable Coin', version: '1' } }], extensions: [], signers: {} });
    });
    const app = new Hono();
    app.use(radiusPayments({ network: 'testnet', payTo: PAY_TO, facilitator: { url: 'https://my-facilitator.example/', apiKey: 'k1' }, routes: { 'GET /p': '$1' } }));
    app.get('/p', (c) => c.text('x'));
    await app.request('/p');
    expect(calls[0].url).toBe('https://my-facilitator.example/supported');
    expect(calls[0].headers.get('x-api-key')).toBe('k1');
  });

  it('accepts a self-hosted FacilitatorClient object', async () => {
    const seen: string[] = [];
    const custom = {
      async getSupported() { seen.push('supported'); return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:72344' as const, extra: { assetTransferMethod: 'permit2', name: 'Stable Coin', version: '1' } }], extensions: [], signers: {} }; },
      async verify() { seen.push('verify'); return { isValid: true, payer: '0xabc' }; },
      async settle() { seen.push('settle'); return { success: true, transaction: '0x1', network: 'eip155:72344' as const, payer: '0xabc' }; },
    };
    const app = new Hono();
    app.use(radiusPayments({ network: 'testnet', payTo: PAY_TO, facilitator: custom, routes: { 'GET /api/lookup': '$0.001' } }));
    app.get('/api/lookup', (c) => c.json({ data: 'secret' }));
    const sig = await payloadFor(app);
    const res = await app.request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': sig } });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['supported', 'settle']);
  });
});

describe('radiusPayments paid flow (facilitator mocked)', () => {
  function mockFacilitator(settle: { success: boolean; transaction?: string; errorReason?: string }) {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.endsWith('/verify')) return Response.json({ isValid: true, payer: '0xabc' });
      if (url.endsWith('/settle')) return Response.json({ success: settle.success, transaction: settle.transaction ?? '', network: 'eip155:72344', payer: '0xabc', errorReason: settle.errorReason });
      throw new Error(`unexpected fetch ${url}`);
    });
    return calls;
  }

  it('verifies, settles before the handler, and serves the resource with a receipt', async () => {
    const calls = mockFacilitator({ success: true, transaction: '0xdeadbeef' });
    const settled: unknown[] = [];
    const app = makeApp({ onSettled: (r) => { settled.push(r); } });
    const sig = await payloadFor(app);
    const res = await app.request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': sig } });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: string; payment: { transaction: string } };
    expect(body.data).toBe('secret');
    expect(body.payment.transaction).toBe('0xdeadbeef');
    expect((body.payment as { amount?: string }).amount).toBe('1000');
    // 'upfront' flow: the facilitator's /settle performs verification, no separate /verify round-trip.
    expect(calls.filter((u) => u.endsWith('/verify'))).toHaveLength(0);
    expect(calls.filter((u) => u.endsWith('/settle'))).toHaveLength(1);
    const receipt = getPaymentReceipt(res);
    expect(receipt).toMatchObject({ success: true, transaction: '0xdeadbeef', network: 'eip155:72344' });
    expect(settled).toHaveLength(1);
  });

  it('withholds the resource when settlement fails', async () => {
    mockFacilitator({ success: false, errorReason: 'insufficient_funds' });
    const app = makeApp();
    const sig = await payloadFor(app);
    const res = await app.request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': sig } });
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain('secret');
  });

  it('rejects a malformed payment header without calling the facilitator', async () => {
    const calls = mockFacilitator({ success: true });
    const res = await makeApp().request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': 'not-base64-json' } });
    expect(res.status).toBe(402);
    expect(calls).toHaveLength(0);
  });
});

describe('radiusPayments when the facilitator gives no answer', () => {
  // A settle that fails without the facilitator's own answer may still have reached the chain,
  // so the buyer must see 502 (outcome unknown), not 402 (rejected, nothing moved).
  function mockFacilitator(respond: (path: 'verify' | 'settle') => Response | Promise<Response>) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/verify')) return respond('verify');
      if (url.endsWith('/settle')) return respond('settle');
      throw new Error(`unexpected fetch ${url}`);
    });
  }
  const gatewayTimeout = () => new Response('<html>504 Gateway Time-out</html>', { status: 504, headers: { 'content-type': 'text/html' } });
  const verified = () => Response.json({ isValid: true, payer: '0xabc' });

  async function pay(app: Hono<any>) {
    const sig = await payloadFor(app);
    return app.request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': sig } });
  }

  it('answers 502 when settle returns an error page', async () => {
    mockFacilitator(gatewayTimeout);
    const res = await pay(makeApp());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'facilitator_error' });
  });

  it('answers 502 when the settle connection fails', async () => {
    mockFacilitator(() => {
      throw new TypeError('fetch failed');
    });
    const res = await pay(makeApp());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('secret');
  });

  it('answers 502 when settle fails after the handler (settle: "after")', async () => {
    mockFacilitator((path) => (path === 'verify' ? verified() : gatewayTimeout()));
    const res = await pay(makeApp({ settle: 'after' }));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('secret');
  });

  it('answers 502 when verify returns an error page (settle: "after")', async () => {
    mockFacilitator(gatewayTimeout);
    const res = await pay(makeApp({ settle: 'after' }));
    expect(res.status).toBe(502);
  });

  it("keeps 402 for the facilitator's own settle rejection", async () => {
    mockFacilitator(() => Response.json({ success: false, errorReason: 'insufficient_funds', transaction: '', network: 'eip155:72344' }, { status: 400 }));
    const res = await pay(makeApp());
    expect(res.status).toBe(402);
  });
});
