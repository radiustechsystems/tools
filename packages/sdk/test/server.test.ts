import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { createRadiusServer, radiusPayments, requestOf, type PaymentHandler } from '../src/server/index.js';
import { getPaymentReceipt } from '../src/receipt.js';

const PAY_TO = '0x1eF420190c299D4d133fE9227F780D7d5cE91BeE';

function makeHandler(opts: Partial<Parameters<typeof radiusPayments>[0]> = {}) {
  return radiusPayments({
    network: 'testnet',
    payTo: PAY_TO,
    facilitator: { live: false },
    routes: {
      'GET /api/lookup': { price: '$0.001', description: 'Lookup' },
      'POST /api/query': '0.01',
      'GET /api/atomic': { price: { amount: '42' } },
    },
    ...opts,
  });
}

/** A minimal app: free `/health`, paid `/api/*`, echoing the receipt the handler received. */
function makeApp(pay: PaymentHandler) {
  return pay.wrap((request, payment) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') return Response.json({ ok: true });
    if (pathname === '/api/lookup') return Response.json({ data: 'secret', payment });
    if (pathname === '/api/fail') return Response.json({ error: 'nope' }, { status: 500 });
    if (pathname === '/api/throw') throw new Error('boom');
    return Response.json({ data: pathname });
  });
}

afterEach(() => vi.restoreAllMocks());

async function payloadFor(app: (r: Request) => Promise<Response>, url = 'http://seller.test/api/lookup') {
  const challenge = await app(new Request(url));
  const pr = decodePaymentRequiredHeader(challenge.headers.get('payment-required')!);
  const accepted = pr.accepts[0];
  const { paymentFlow: _pf, ...extra } = accepted.extra as Record<string, unknown>;
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: pr.resource,
    accepted: { ...accepted, extra },
    payload: { signature: '0xsig', permit2Authorization: {} },
  });
}

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

describe('radiusPayments (web-standard handler): 402 challenge', () => {
  it('leaves unprotected routes alone and reports requiresPayment without I/O', async () => {
    const pay = makeHandler();
    const res = await makeApp(pay)(new Request('http://seller.test/health'));
    expect(res.status).toBe(200);
    expect(pay.requiresPayment(new Request('http://seller.test/health'))).toBe(false);
    expect(pay.requiresPayment(new Request('http://seller.test/api/lookup'))).toBe(true);
    expect(pay.requiresPayment(new Request('http://seller.test/api/lookup', { method: 'POST' }))).toBe(false);
  });

  it('returns a standard x402 v2 challenge for SBC via EIP-3009 (listed first by the facilitator), with no gas-sponsoring declaration', async () => {
    const res = await makeHandler()(new Request('http://seller.test/api/lookup?q=1'), () => Response.json({ leaked: true }));
    expect(res.status).toBe(402);
    expect(res.headers.get('content-type')).toContain('application/json');
    const pr = decodePaymentRequiredHeader(res.headers.get('payment-required')!);
    expect(pr.x402Version).toBe(2);
    expect(pr.resource.url).toBe('http://seller.test/api/lookup?q=1');
    expect(pr.resource.description).toBe('Lookup');
    expect(pr.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:72344',
      amount: '1000',
      asset: '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb',
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'eip3009', name: 'Stable Coin', version: '1', paymentFlow: 'upfront' },
    });
    // EIP-3009 needs no approval, so there is nothing for the facilitator to sponsor.
    expect(pr.extensions).toBeUndefined();
    expect(await res.text()).not.toContain('leaked');
  });

  it('supports shorthand and atomic prices', async () => {
    const app = makeApp(makeHandler());
    const post = await app(new Request('http://seller.test/api/query', { method: 'POST' }));
    expect(decodePaymentRequiredHeader(post.headers.get('payment-required')!).accepts[0].amount).toBe('10000');
    const atomic = await app(new Request('http://seller.test/api/atomic'));
    expect(decodePaymentRequiredHeader(atomic.headers.get('payment-required')!).accepts[0].amount).toBe('42');
  });

  it('resolves payTo and price dynamically from the Request', async () => {
    const pay = radiusPayments({
      network: 'testnet',
      facilitator: { live: false },
      payTo: (request) => request.headers.get('x-pay-to') as `0x${string}`,
      routes: { 'GET /p': { price: (request) => `$${new URL(request.url).searchParams.get('n')}` } },
    });
    const res = await pay(new Request('http://seller.test/p?n=2', { headers: { 'x-pay-to': PAY_TO } }), () => new Response('x'));
    const accepted = decodePaymentRequiredHeader(res.headers.get('payment-required')!).accepts[0];
    expect(accepted.payTo).toBe(PAY_TO);
    expect(accepted.amount).toBe('2000000');
  });

  it('serves browsers an HTML paywall page', async () => {
    const res = await makeHandler()(new Request('http://seller.test/api/lookup', { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0' } }), () => new Response('x'));
    expect(res.status).toBe(402);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

describe('radiusPayments (web-standard handler): paid flow (facilitator mocked)', () => {
  it('settles before the handler, passes the receipt to it, and attaches PAYMENT-RESPONSE', async () => {
    const calls = mockFacilitator({ success: true, transaction: '0xdeadbeef' });
    const settled: { receipt: unknown; url: string }[] = [];
    const app = makeApp(makeHandler({ onSettled: (receipt, request) => { settled.push({ receipt, url: request.url }); } }));
    const sig = await payloadFor(app);
    const res = await app(new Request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': sig } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: string; payment: { transaction: string; amount: string } };
    expect(body.data).toBe('secret');
    expect(body.payment).toMatchObject({ success: true, transaction: '0xdeadbeef', amount: '1000', payer: '0xabc' });
    expect(calls.filter((u) => u.endsWith('/verify'))).toHaveLength(0);
    expect(calls.filter((u) => u.endsWith('/settle'))).toHaveLength(1);
    expect(getPaymentReceipt(res)).toMatchObject({ success: true, transaction: '0xdeadbeef', network: 'eip155:72344' });
    expect(res.headers.get('cache-control')).toContain('private');
    expect(settled).toEqual([{ receipt: expect.objectContaining({ transaction: '0xdeadbeef' }), url: 'http://seller.test/api/lookup' }]);
  });

  it('settle: "after" runs the handler first, then settles; the handler sees no receipt', async () => {
    const calls = mockFacilitator({ success: true, transaction: '0xafter' });
    const seen: unknown[] = [];
    const app = makeHandler({ settle: 'after' }).wrap((_r, payment) => {
      seen.push(payment);
      return Response.json({ ok: true });
    });
    const sig = await payloadFor(app);
    const res = await app(new Request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': sig } }));
    expect(res.status).toBe(200);
    expect(seen).toEqual([undefined]);
    expect(calls.filter((u) => u.endsWith('/verify'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('/settle'))).toHaveLength(1);
    expect(getPaymentReceipt(res)?.transaction).toBe('0xafter');
  });

  it('withholds the resource when settlement fails and does not call onSettled', async () => {
    mockFacilitator({ success: false, errorReason: 'insufficient_funds' });
    const settled: unknown[] = [];
    const app = makeApp(makeHandler({ onSettled: (r) => { settled.push(r); } }));
    const sig = await payloadFor(app);
    const res = await app(new Request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': sig } }));
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain('secret');
    expect(settled).toHaveLength(0);
  });

  it('rejects a malformed payment header without calling the facilitator', async () => {
    const calls = mockFacilitator({ success: true });
    const res = await makeApp(makeHandler())(new Request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': 'not-base64-json' } }));
    expect(res.status).toBe(402);
    expect(calls).toHaveLength(0);
  });

  it('streams the handler response through in settle-before mode', async () => {
    mockFacilitator({ success: true, transaction: '0xstream' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const app = makeHandler().wrap(() => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('first,'));
          await gate;
          controller.enqueue(new TextEncoder().encode('second'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    });
    const sig = await payloadFor(app);
    const res = await app(new Request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': sig } }));
    expect(res.status).toBe(200);
    expect(getPaymentReceipt(res)?.transaction).toBe('0xstream');
    // The response (and its first chunk) arrive while the handler is still producing the rest.
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('first,');
    release();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('second');
    expect((await reader.read()).done).toBe(true);
  });

  it('handles responses with immutable headers (e.g. proxied from fetch)', async () => {
    mockFacilitator({ success: true, transaction: '0x1' });
    const pay = makeHandler();
    const app = pay.wrap(async () => {
      const upstream = new Response('proxied', { headers: { 'x-upstream': '1' } });
      // Simulate `fetch()`'s immutable headers guard.
      Object.defineProperty(upstream, 'headers', { value: new Proxy(upstream.headers, { get: (t, k) => (k === 'set' || k === 'delete' ? () => { throw new TypeError('immutable'); } : Reflect.get(t, k).bind(t)) }) });
      return upstream;
    });
    const sig = await payloadFor(app);
    const res = await app(new Request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': sig } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('proxied');
    expect(res.headers.get('x-upstream')).toBe('1');
    expect(getPaymentReceipt(res)?.transaction).toBe('0x1');
  });

  it('returns the handler error with the settlement receipt when a paid handler fails', async () => {
    mockFacilitator({ success: true, transaction: '0x2' });
    const app = makeApp(makeHandler({ routes: { 'GET /api/fail': '$0.001', 'GET /api/throw': '$0.001' } }));
    const sig = await payloadFor(app, 'http://seller.test/api/fail');
    const failed = await app(new Request('http://seller.test/api/fail', { headers: { 'PAYMENT-SIGNATURE': sig } }));
    expect(failed.status).toBe(500);
    expect(getPaymentReceipt(failed)?.transaction).toBe('0x2');
    const sig2 = await payloadFor(app, 'http://seller.test/api/throw');
    const threw = await app(new Request('http://seller.test/api/throw', { headers: { 'PAYMENT-SIGNATURE': sig2 } }));
    expect(threw.status).toBe(500);
    expect(await threw.json()).toMatchObject({ error: 'payment_processing_error', message: 'boom' });
    expect(getPaymentReceipt(threw)?.transaction).toBe('0x2');
  });
});

describe('radiusPayments (web-standard handler) when the facilitator gives no answer', () => {
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

  async function pay(app: (r: Request) => Promise<Response>) {
    const sig = await payloadFor(app);
    return app(new Request('http://seller.test/api/lookup', { headers: { 'PAYMENT-SIGNATURE': sig } }));
  }

  it('answers 502 when settle returns an error page', async () => {
    mockFacilitator(gatewayTimeout);
    const res = await pay(makeApp(makeHandler()));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'facilitator_error' });
  });

  it('answers 502 when the settle connection fails', async () => {
    mockFacilitator(() => {
      throw new TypeError('fetch failed');
    });
    const res = await pay(makeApp(makeHandler()));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('secret');
  });

  it('answers 502 when settle fails after the handler (settle: "after")', async () => {
    mockFacilitator((path) => (path === 'verify' ? verified() : gatewayTimeout()));
    const res = await pay(makeApp(makeHandler({ settle: 'after' })));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('secret');
  });

  it('answers 502 when verify returns an error page (settle: "after")', async () => {
    mockFacilitator(gatewayTimeout);
    const res = await pay(makeApp(makeHandler({ settle: 'after' })));
    expect(res.status).toBe(502);
  });

  it("keeps 402 for the facilitator's own settle rejection", async () => {
    mockFacilitator(() => Response.json({ success: false, errorReason: 'insufficient_funds', transaction: '', network: 'eip155:72344' }, { status: 400 }));
    const res = await pay(makeApp(makeHandler()));
    expect(res.status).toBe(402);
  });
});

describe('createRadiusServer', () => {
  it('builds upstream-compatible routes and a resource server that answers 402s through @x402/express', async () => {
    const { paymentMiddleware } = await import('@x402/express');
    const express = (await import('express')).default;
    const seen: string[] = [];
    const radius = createRadiusServer({ network: 'testnet', facilitator: { live: false }, onSettled: (r, ctx) => { seen.push(`${r.transaction}:${requestOf(ctx) ? 'request' : 'express'}`); } });
    const app = express();
    app.use(paymentMiddleware(radius.routes({ payTo: PAY_TO, routes: { 'GET /api/lookup': '$0.001' } }), radius.server));
    app.get('/api/lookup', (_req, res) => { res.json({ data: 'secret' }); });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const challenge = await fetch(`${base}/api/lookup`);
      expect(challenge.status).toBe(402);
      const pr = decodePaymentRequiredHeader(challenge.headers.get('payment-required')!);
      expect(pr.accepts[0]).toMatchObject({ scheme: 'exact', network: 'eip155:72344', amount: '1000', payTo: PAY_TO, extra: { assetTransferMethod: 'eip3009', paymentFlow: 'upfront' } });
      expect(pr.extensions).toBeUndefined();

      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith('/settle')) return Response.json({ success: true, transaction: '0xexpress', network: 'eip155:72344', payer: '0xabc' });
        return realFetch(input, init);
      });
      const accepted = pr.accepts[0];
      const { paymentFlow: _pf, ...extra } = accepted.extra as Record<string, unknown>;
      const sig = encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: { ...accepted, extra }, payload: { signature: '0xsig', permit2Authorization: {} } });
      const paid = await fetch(`${base}/api/lookup`, { headers: { 'PAYMENT-SIGNATURE': sig } });
      expect(paid.status).toBe(200);
      expect(await paid.json()).toEqual({ data: 'secret' });
      expect(getPaymentReceipt(paid)?.transaction).toBe('0xexpress');
      expect(seen).toEqual(['0xexpress:express']);
    } finally {
      server.close();
    }
  });

  it('settle: "after" and failed handlers behave the same through @x402/express', async () => {
    const { paymentMiddleware } = await import('@x402/express');
    const express = (await import('express')).default;
    const seen: string[] = [];
    const radius = createRadiusServer({ network: 'testnet', facilitator: { live: false }, settle: 'after', onSettled: (r) => { seen.push(r.transaction!); } });
    const app = express();
    app.use(paymentMiddleware(radius.routes({ payTo: PAY_TO, routes: { 'GET /api/lookup': '$0.001', 'GET /api/fail': '$0.001' } }), radius.server));
    app.get('/api/lookup', (_req, res) => { res.json({ data: 'secret' }); });
    app.get('/api/fail', (_req, res) => { res.status(500).json({ error: 'nope' }); });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const realFetch = globalThis.fetch;
    const facilitatorCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/verify')) { facilitatorCalls.push('verify'); return Response.json({ isValid: true, payer: '0xabc' }); }
      if (url.endsWith('/settle')) { facilitatorCalls.push('settle'); return Response.json({ success: true, transaction: '0xafter', network: 'eip155:72344', payer: '0xabc' }); }
      return realFetch(input, init);
    });
    const payloadFor = async (path: string) => {
      const pr = decodePaymentRequiredHeader((await fetch(`${base}${path}`)).headers.get('payment-required')!);
      expect(pr.accepts[0].extra).not.toHaveProperty('paymentFlow');
      return encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: '0xsig', permit2Authorization: {} } });
    };
    try {
      const paid = await fetch(`${base}/api/lookup`, { headers: { 'PAYMENT-SIGNATURE': await payloadFor('/api/lookup') } });
      expect(paid.status).toBe(200);
      expect(getPaymentReceipt(paid)?.transaction).toBe('0xafter');
      expect(facilitatorCalls).toEqual(['verify', 'settle']);
      expect(seen).toEqual(['0xafter']);

      const failed = await fetch(`${base}/api/fail`, { headers: { 'PAYMENT-SIGNATURE': await payloadFor('/api/fail') } });
      expect(failed.status).toBe(500);
      // Verified but never settled: the handler failed first, so no funds moved.
      expect(facilitatorCalls).toEqual(['verify', 'settle', 'verify']);
      expect(seen).toEqual(['0xafter']);
    } finally {
      server.close();
    }
  });
});
