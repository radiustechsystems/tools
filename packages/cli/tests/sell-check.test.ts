import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { generatePrivateKey } from 'viem/accounts';
import { resolveNetwork } from 'radius-sdk';
import { radiusPayments, type RadiusPaymentsOptions } from 'radius-sdk/server';
import { checkSeller, readRateLimit, type SellCheckReport } from '../src/lib/sellCheck.js';
import { checkRoutes } from '../src/lib/sellCheckRoutes.js';
import { parsePricingMd } from '../src/lib/pricingMd.js';

// A real radius-sdk seller over loopback HTTP, a mock facilitator and a mock JSON-RPC node. Nothing
// leaves the machine; "settlement" is the mock facilitator saying so.

const TESTNET = resolveNetwork('testnet');
const BASE_SEPOLIA = resolveNetwork('base-sepolia');
const PAY_TO = '0x1eF420190c299D4d133fE9227F780D7d5cE91BeE';
const MPP_SECRET = 'sell-check-test-secret-0123456789abcdef';

interface Listening { url: string; close: () => Promise<void> }

function listen(server: Server): Promise<Listening> {
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      done({ url: `http://127.0.0.1:${port}`, close: () => new Promise((closed) => { server.closeAllConnections(); server.close(() => closed()); }) });
    });
  });
}

const open: Listening[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

/** `/supported` lists `kinds` ([network, transfer method]); `/settle` always succeeds; counts settles. */
async function facilitator(kinds: [string, string][], extensions = ['eip2612GasSponsoring']) {
  const state = { settles: 0, url: '' };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const send = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/supported') {
      send({ kinds: kinds.map(([network, assetTransferMethod]) => ({ x402Version: 2, scheme: 'exact', network, extra: { assetTransferMethod } })), extensions, signers: {} });
      return;
    }
    const { paymentRequirements } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (req.url === '/verify') { send({ isValid: true, payer: PAY_TO }); return; }
    state.settles++;
    send({ success: true, transaction: `0x${String(state.settles).padStart(64, '0')}`, network: paymentRequirements?.network, payer: '0x00000000000000000000000000000000000a11ce' });
  });
  const l = await listen(server);
  open.push(l);
  state.url = l.url;
  return state;
}

/** Serve a radius-sdk seller: `GET /api/report` paid, `GET /health` free. */
async function seller(options: Partial<RadiusPaymentsOptions>, transform?: (res: Response) => Response | Promise<Response>) {
  const pay = radiusPayments({ network: 'testnet', payTo: PAY_TO, routes: { 'GET /api/report': { price: '$0.001', description: 'Report' } }, ...options } as RadiusPaymentsOptions);
  const app = pay.wrap((request) => (new URL(request.url).pathname === '/health' || new URL(request.url).pathname === '/api/report'
    ? Response.json({ report: 'quarterly-sales' })
    : new Response('not found', { status: 404 })));
  const server = createServer(async (req, res) => {
    let response = await app(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers as Record<string, string> }));
    if (transform) response = await transform(response);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  const l = await listen(server);
  open.push(l);
  return l.url;
}

let rpc: Listening;
beforeAll(async () => {
  // eth_chainId and a large balanceOf, enough for the --pay balance check.
  rpc = await listen(createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = JSON.parse(Buffer.concat(chunks).toString());
    const answer = (call: { id: number; method: string }) => ({
      jsonrpc: '2.0', id: call.id,
      result: call.method === 'eth_chainId' ? `0x${TESTNET.chainId.toString(16)}` : `0x${(10n ** 12n).toString(16).padStart(64, '0')}`,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(raw) ? raw.map(answer) : answer(raw)));
  }));
});
afterAll(() => rpc.close());

const statusOf = (report: SellCheckReport, id: string) => report.checks.find((c) => c.id === id)?.status;
const failed = (report: SellCheckReport) => report.checks.filter((c) => c.status === 'fail').map((c) => c.id);
const radiusKinds: [string, string][] = [[TESTNET.network, 'eip3009'], [TESTNET.network, 'permit2']];

describe('radius-cli sell check', () => {
  it('passes a correct radius-sdk seller and reads its MPP challenge', async () => {
    const fac = await facilitator(radiusKinds);
    const url = `${await seller({ facilitator: { url: fac.url }, mpp: { secretKey: MPP_SECRET } })}/api/report`;
    const report = await checkSeller({ url, price: '$0.001', facilitators: [fac.url] });
    expect(failed(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.offers).toMatchObject([{ scheme: 'exact', network: TESTNET.network, amount: '1000', amountFormatted: '0.001 SBC', transferMethod: 'eip3009' }]);
    for (const id of ['status', 'cache', 'x402', 'resource', 'offer[0].asset', 'offer[0].domain', 'offer[0].amount', 'offer[0].payTo', 'offer[0].maxTimeoutSeconds', 'offer[0].facilitator', 'mpp', 'mpp[0].challenge', 'mpp[0].mirror', 'buyer.x402', 'buyer.mpp']) {
      expect(statusOf(report, id), id).toBe('pass');
    }
    expect(report.facilitators[fac.url]?.ok).toBe(true);
    expect(fac.settles).toBe(0);
  });

  it('reports a seller without MPP as information, not a failure', async () => {
    const fac = await facilitator(radiusKinds);
    const report = await checkSeller({ url: `${await seller({ facilitator: { url: fac.url } })}/api/report`, facilitators: [fac.url] });
    expect(report.ok).toBe(true);
    expect(statusOf(report, 'mpp')).toBe('info');
    // SDK-neutral: says what it means for buyers, and names radius-sdk only as one way to add MPP.
    const mpp = report.checks.find((c) => c.id === 'mpp')!.message;
    expect(mpp).toMatch(/buyers can pay over x402 only/);
    expect(mpp).toMatch(/seller's payment setup \(with radius-sdk: mpp: \{ secretKey \}/);
    expect(mpp).not.toMatch(/upstream x402 adapters/);
    expect(report.mpp).toEqual([]);
    expect(statusOf(report, 'buyer.mpp')).toBeUndefined();
  });

  it('fails an amount priced with the wrong decimals, and names them', async () => {
    const fac = await facilitator(radiusKinds);
    const url = `${await seller({ facilitator: { url: fac.url }, asset: { decimals: 18 }, mpp: { secretKey: MPP_SECRET } })}/api/report`;
    const report = await checkSeller({ url, price: '$0.001', facilitators: [fac.url] });
    expect(report.ok).toBe(false);
    const amount = report.checks.find((c) => c.id === 'offer[0].amount')!;
    expect(amount.status).toBe('fail');
    expect(amount.message).toMatch(/1000000000000000.*18 decimals.*SBC has 6/);
    expect(report.checks.find((c) => c.id === 'mpp[0].challenge')?.message).toMatch(/decimals 18, but SBC has 6/);
    // A --price finer than the asset's decimals is a failed check, not a crash.
    const fine = await checkSeller({ url, price: '$0.0000001', facilitators: [fac.url] });
    expect(fine.checks.find((c) => c.id === 'offer[0].amount')?.message).toMatch(/cannot be priced in SBC/);
    // Without --price, the absurd per-request amount is still flagged.
    const loose = await checkSeller({ url, facilitators: [fac.url] });
    expect(statusOf(loose, 'offer[0].amount')).toBe('warn');
  });

  it('fails an offer in another asset than the network’s', async () => {
    const fac = await facilitator(radiusKinds);
    const url = `${await seller({ facilitator: { url: fac.url }, asset: { address: '0x000000000000000000000000000000000000dEaD' } })}/api/report`;
    const report = await checkSeller({ url, facilitators: [fac.url] });
    expect(report.ok).toBe(false);
    expect(statusOf(report, 'offer[0].asset')).toBe('fail');
    expect(report.checks.find((c) => c.id === 'buyer.x402')?.message).toMatch(/asset_mismatch/);
  });

  it('fails when the facilitator does not support the offered network or transfer method', async () => {
    const sellerFac = await facilitator(radiusKinds);
    const url = `${await seller({ facilitator: { url: sellerFac.url } })}/api/report`;
    const otherNetwork = await facilitator([[BASE_SEPOLIA.network, 'eip3009']]);
    const report = await checkSeller({ url, facilitators: [otherNetwork.url] });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'offer[0].facilitator')?.message).toMatch(/does not support eip155:72344 at all/);
    const permit2Only = await facilitator([[TESTNET.network, 'permit2']]);
    const methodReport = await checkSeller({ url, facilitators: [permit2Only.url] });
    expect(methodReport.checks.find((c) => c.id === 'offer[0].facilitator')?.message).toMatch(/does not support exact\/eip3009/);
    const unreachable = await checkSeller({ url, facilitators: ['http://127.0.0.1:9'], timeoutMs: 2000 });
    expect(statusOf(unreachable, 'offer[0].facilitator')).toBe('fail');
  });

  it('fails when the route answers without a 402', async () => {
    const fac = await facilitator(radiusKinds);
    const report = await checkSeller({ url: `${await seller({ facilitator: { url: fac.url } })}/health`, facilitators: [fac.url] });
    expect(report.ok).toBe(false);
    expect(report.status).toBe(200);
    expect(report.checks).toEqual([expect.objectContaining({ id: 'status', status: 'fail', message: expect.stringMatching(/served without payment and without RateLimit headers, so it is not a free quota/) })]);
    expect(report.freeQuota).toBeUndefined();
  });

  describe('free quotas', () => {
    /**
     * A radius-sdk seller behind a free quota of `limit` unpaid requests: each is served 200 with
     * RateLimit headers, as the Radius Platform's policy sends them; after that the 402 comes through.
     */
    async function quotaSeller(limit: number, headers: (remaining: number) => Record<string, string> = (remaining) => ({ 'RateLimit-Limit': String(limit), 'RateLimit-Remaining': String(remaining), 'RateLimit-Reset': '42' })) {
      const fac = await facilitator(radiusKinds);
      const counter = { requests: 0 };
      const url = `${await seller({ facilitator: { url: fac.url } }, (res) => {
        counter.requests++;
        if (counter.requests > limit) return res;
        return Response.json({ free: true }, { headers: headers(limit - counter.requests) });
      })}/api/report`;
      return { fac, url, counter };
    }

    it('reads RateLimit headers, and their X-RateLimit form', () => {
      expect(readRateLimit(new Headers({ 'RateLimit-Limit': '10', 'RateLimit-Remaining': '9', 'RateLimit-Reset': '50' }))).toEqual({ limit: 10, remaining: 9, resetSeconds: 50 });
      expect(readRateLimit(new Headers({ 'X-RateLimit-Remaining': '3' }))).toEqual({ remaining: 3, limit: undefined, resetSeconds: undefined });
      expect(readRateLimit(new Headers({ 'RateLimit-Limit': '10' }))).toBeUndefined();
      expect(readRateLimit(new Headers({ 'RateLimit-Remaining': 'lots' }))).toBeUndefined();
    });

    it('uses up the quota, then checks the 402', async () => {
      const { fac, url, counter } = await quotaSeller(10);
      const report = await checkSeller({ url, price: '$0.001', facilitators: [fac.url] });
      expect(failed(report)).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.status).toBe(402);
      expect(report.freeQuota).toEqual({ limit: 10, remaining: 0, resetSeconds: 42, served: 10, exhausted: true });
      expect(report.checks.find((c) => c.id === 'free-quota')).toMatchObject({ status: 'info', message: expect.stringMatching(/10 unpaid GET requests were served \(limit 10, 0 remaining, resets in 42 s\), then 402/) });
      expect(report.checks.find((c) => c.id === 'status')?.message).toMatch(/answers 402 once the free quota is used up/);
      expect(statusOf(report, 'offer[0].amount')).toBe('pass');
      // The 10 free answers and the 402: nothing more.
      expect(counter.requests).toBe(11);
    });

    it('with --free-requests 0, reports the quota without spending it and does not fail', async () => {
      const { url, counter } = await quotaSeller(10);
      const report = await checkSeller({ url, freeRequests: 0 });
      expect(report.ok).toBe(true);
      expect(report.status).toBe(200);
      expect(report.offers).toEqual([]);
      expect(report.freeQuota).toMatchObject({ limit: 10, remaining: 9, served: 1, exhausted: false });
      expect(report.checks).toEqual([expect.objectContaining({ id: 'free-quota', status: 'info', message: expect.stringMatching(/a free quota, not used up \(--free-requests 0\), so the 402 was not checked/) })]);
      expect(counter.requests).toBe(1);
    });

    it('does not start on a quota larger than --free-requests, and warns', async () => {
      const { url, counter } = await quotaSeller(50);
      const report = await checkSeller({ url });
      expect(report.ok).toBe(true);
      expect(report.checks).toEqual([expect.objectContaining({ id: 'free-quota', status: 'warn', message: expect.stringMatching(/takes 50 more unpaid requests, more than --free-requests 25/) })]);
      expect(counter.requests).toBe(1);
      // Raised, it gets there (49 free answers left: the first run used one).
      const raised = await checkSeller({ url, freeRequests: 60, facilitators: ['http://127.0.0.1:9'], timeoutMs: 1000 });
      expect(raised.freeQuota).toMatchObject({ served: 49, exhausted: true });
      expect(counter.requests).toBe(51);
      expect(statusOf(raised, 'status')).toBe('pass');
    });

    it('stops at --free-requests when the headers never run out, and warns', async () => {
      const { url, counter } = await quotaSeller(1000, () => ({ 'RateLimit-Remaining': '1' }));
      const report = await checkSeller({ url, freeRequests: 5 });
      expect(report.ok).toBe(true);
      expect(report.checks.find((c) => c.id === 'free-quota')).toMatchObject({ status: 'warn', message: expect.stringMatching(/still served after 6 unpaid requests \(--free-requests 5\)/) });
      expect(counter.requests).toBe(6);
    });
  });

  describe('every route of a pricing.md', () => {
    const pricing = (base: string) => [
      '# Acme pricing',
      '',
      '## Chain \\*data\\*',
      '',
      `- Base URL: ${base}`,
      '- Payment: x402, SBC on Radius testnet',
      '',
      '### Wallet history',
      '',
      '- Request: `GET /wallet/:address`',
      '- Price: $0.001 / request',
      '- Free: 2 requests per minute per IP',
      '',
      '### Transaction',
      '',
      '- Request: `GET /tx/:transfer_type/:hash`',
      '- Price: $0.002 / request',
      '',
      '### Value types',
      '',
      '- Request: `GET /value/:id`',
      '- Price: $0.001 / request',
      '',
    ].join('\n');

    it('checks each route against its own price, skips unfilled parameters and totals the results', async () => {
      const fac = await facilitator(radiusKinds);
      // The seller charges 0.001 SBC everywhere, so the Transaction route (listed at $0.002) fails.
      let walletRequests = 0;
      const base = await seller({ facilitator: { url: fac.url }, routes: { 'GET /wallet/*': { price: '$0.001' }, 'GET /tx/*': { price: '$0.001' }, 'GET /value/*': { price: '$0.001' } } }, (res) => {
        if (res.status === 402 && new URL(JSON.parse(Buffer.from(res.headers.get('payment-required')!, 'base64').toString()).resource.url).pathname.startsWith('/wallet/') && ++walletRequests <= 2) {
          return Response.json({ free: true }, { headers: { 'RateLimit-Limit': '2', 'RateLimit-Remaining': String(2 - walletRequests), 'RateLimit-Reset': '60' } });
        }
        return res;
      });
      const routes = parsePricingMd(pricing('[Base URL]'));
      const seen: string[] = [];
      const result = await checkRoutes('pricing.md', routes, { address: '0xabc', hash: '0x01', transfer_type: 'radius' }, base, { facilitators: [fac.url] }, (r) => seen.push(r.path));
      expect(seen).toEqual(['/wallet/:address', '/tx/:transfer_type/:hash', '/value/:id']);
      expect(result.ok).toBe(false);
      expect(result.summary.routes).toEqual({ checked: 2, passed: 1, failed: 1, skipped: 1 });
      const [wallet, tx, value] = result.routes;
      expect(wallet).toMatchObject({ catalog: 'Chain *data*', name: 'Wallet history', method: 'GET', price: '$0.001', free: '2 requests per minute per IP', url: `${base}/wallet/0xabc` });
      expect(wallet!.report).toMatchObject({ ok: true, freeQuota: { limit: 2, served: 2, exhausted: true } });
      expect(tx!.url).toBe(`${base}/tx/radius/0x01`);
      expect(tx!.report!.checks.find((c) => c.id === 'offer[0].amount')).toMatchObject({ status: 'fail', message: expect.stringMatching(/expected \$0.002/) });
      expect(value).toMatchObject({ skipped: "no value for :id; pass --param 'id=…'" });
      expect(value!.report).toBeUndefined();
      expect(result.summary.checks.fail).toBe(1);
    });

    it('skips every route without a base URL, and is not ok when nothing was checked', async () => {
      const result = await checkRoutes('pricing.md', parsePricingMd(pricing('[Base URL]')), {}, undefined, {});
      expect(result.ok).toBe(false);
      expect(result.summary.routes).toEqual({ checked: 0, passed: 0, failed: 0, skipped: 3 });
      expect(result.routes[0]!.skipped).toMatch(/has no Base URL; pass --base-url/);
    });
  });

  it('fails a challenge bound to another resource or paying a zero address', async () => {
    const fac = await facilitator(radiusKinds);
    const url = `${await seller({ facilitator: { url: fac.url } }, (res) => {
      if (res.status !== 402) return res;
      const challenge = JSON.parse(Buffer.from(res.headers.get('payment-required')!, 'base64').toString());
      challenge.resource.url = 'http://127.0.0.1/somewhere-else';
      challenge.accepts[0].payTo = '0x0000000000000000000000000000000000000000';
      const headers = new Headers(res.headers);
      headers.set('payment-required', Buffer.from(JSON.stringify(challenge)).toString('base64'));
      return new Response(null, { status: 402, headers });
    })}/api/report`;
    const report = await checkSeller({ url, facilitators: [fac.url] });
    expect(failed(report)).toEqual(expect.arrayContaining(['resource', 'offer[0].payTo']));
  });

  it('warns when an unpaid HEAD is served', async () => {
    const fac = await facilitator(radiusKinds);
    const report = await checkSeller({ url: `${await seller({ facilitator: { url: fac.url } })}/api/report`, facilitators: [fac.url], probeHead: true });
    expect(statusOf(report, 'head')).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('--pay makes one payment within the threshold and checks the receipt', async () => {
    const fac = await facilitator(radiusKinds);
    const url = `${await seller({ facilitator: { url: fac.url } })}/api/report`;
    const networks = [resolveNetwork('testnet', { rpcUrl: rpc.url })];
    const report = await checkSeller({ url, facilitators: [fac.url], pay: { networks, signer: generatePrivateKey(), threshold: '0.01' } });
    expect(failed(report)).toEqual([]);
    expect(statusOf(report, 'pay')).toBe('pass');
    expect(statusOf(report, 'pay.receipt')).toBe('pass');
    expect(report.payment).toMatchObject({ paid: true, status: 200, protocol: 'x402', network: TESTNET.network });
    expect(fac.settles).toBe(1);

    const over = await checkSeller({ url, facilitators: [fac.url], pay: { networks, signer: generatePrivateKey(), threshold: '0.0001' } });
    expect(over.ok).toBe(false);
    expect(over.checks.find((c) => c.id === 'pay')?.message).toMatch(/exceeds --threshold 0.0001/);
    expect(fac.settles).toBe(1);
  });

  it('--pay gives the paid request a longer budget, and says a late failure may have settled', async () => {
    const fac = await facilitator(radiusKinds);
    const slow = (ms: number) => async (res: Response) => {
      if (res.status === 200) await new Promise((done) => setTimeout(done, ms));
      return res;
    };
    const networks = [resolveNetwork('testnet', { rpcUrl: rpc.url })];
    const pay = () => ({ networks, signer: generatePrivateKey(), threshold: '0.01' });
    // The paid answer takes longer than --timeout but fits the paid budget.
    const patient = `${await seller({ facilitator: { url: fac.url } }, slow(900))}/api/report`;
    const ok = await checkSeller({ url: patient, facilitators: [fac.url], timeoutMs: 400, paidTimeoutMs: 5000, pay: pay() });
    expect(statusOf(ok, 'pay')).toBe('pass');
    // It fits neither: the payment was sent, so the failure must not read as "nothing was paid".
    const stuck = `${await seller({ facilitator: { url: fac.url } }, slow(5000))}/api/report`;
    const late = await checkSeller({ url: stuck, facilitators: [fac.url], timeoutMs: 400, paidTimeoutMs: 700, pay: pay() });
    expect(late.ok).toBe(false);
    expect(late.checks.find((c) => c.id === 'pay')).toMatchObject({ status: 'fail', message: expect.stringMatching(/payment was sent and may have settled/) });
    expect(fac.settles).toBe(2);
    // A refusal before anything is sent says nothing of the kind.
    const over = await checkSeller({ url: patient, facilitators: [fac.url], timeoutMs: 400, pay: { ...pay(), threshold: '0.0001' } });
    expect(over.checks.find((c) => c.id === 'pay')?.message).not.toMatch(/may have settled/);
  });

  describe('crafted 402s', () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

    /** Serve whatever `reply` sends for every request: for 402s a real seller would never send. */
    async function raw(reply: (req: IncomingMessage, res: ServerResponse) => void) {
      const l = await listen(createServer(reply));
      open.push(l);
      return `${l.url}/api/report`;
    }

    /** The unpaid 402 of a real seller (v2 header, optionally MPP), to rewrite. */
    async function realChallenge(mpp: boolean) {
      const fac = await facilitator(radiusKinds);
      const sellerUrl = await seller({ facilitator: { url: fac.url }, ...(mpp ? { mpp: { secretKey: MPP_SECRET } } : {}) });
      const res = await fetch(`${sellerUrl}/api/report`);
      const header = res.headers.get('payment-required')!;
      return { fac, headers: Object.fromEntries(res.headers), challenge: JSON.parse(Buffer.from(header, 'base64').toString()) as Record<string, any> };
    }

    it('reports a malformed offer as a failed check instead of crashing', async () => {
      const { fac, headers, challenge } = await realChallenge(false);
      for (const accepts of [[null], ['x', 3, []], [challenge.accepts[0], null]]) {
        const url = await raw((_req, res) => {
          res.writeHead(402, { ...headers, 'payment-required': b64({ ...challenge, accepts }) });
          res.end();
        });
        const report = await checkSeller({ url, facilitators: [fac.url] });
        expect(report.ok).toBe(false);
        const bad = accepts.map((a, i) => (a !== null && typeof a === 'object' && !Array.isArray(a) ? undefined : `offer[${i}]`)).filter(Boolean);
        for (const id of bad) expect(statusOf(report, id as string), id as string).toBe('fail');
        // The well-formed offer next to a bad one is still checked.
        if (accepts.length === 2) expect(statusOf(report, 'offer[0].asset')).toBe('pass');
      }
    });

    it('does not crash the MPP mirror check when accepts is an object, missing or malformed', async () => {
      const { headers, challenge } = await realChallenge(true);
      expect(headers['www-authenticate']).toMatch(/^Payment/);
      for (const mutate of [(c: Record<string, any>) => { c.accepts = {}; }, (c: Record<string, any>) => { delete c.accepts; }, (c: Record<string, any>) => { c.accepts = [null]; }]) {
        const broken = structuredClone(challenge);
        mutate(broken);
        const url = await raw((_req, res) => {
          res.writeHead(402, { ...headers, 'payment-required': b64(broken) });
          res.end();
        });
        const report = await checkSeller({ url, facilitators: ['http://127.0.0.1:9'], timeoutMs: 1000 });
        expect(report.ok).toBe(false);
        expect(statusOf(report, 'mpp[0].challenge')).toBe('pass');
        expect(statusOf(report, 'mpp[0].mirror')).toBe('skip');
      }
    });

    const v1Challenge = (url: string) => {
      const base = resolveNetwork('base');
      return { x402Version: 1, error: 'X-PAYMENT header is required', accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '1000', resource: url, description: 'Report', mimeType: 'application/json', payTo: PAY_TO, maxTimeoutSeconds: 60, asset: base.asset.address, extra: { name: base.asset.name, version: base.asset.version } }] };
    };

    it('reads an x402 v1 challenge from the JSON body, as the SDK buyer does', async () => {
      const url = await raw((req, res) => {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v1Challenge(`http://${req.headers.host}${req.url}`)));
      });
      const report = await checkSeller({ url, facilitators: ['http://127.0.0.1:9'], timeoutMs: 1000 });
      expect(report.checks.filter((c) => c.id === 'x402' && c.status === 'fail')).toEqual([]);
      expect(report.x402Version).toBe(1);
      expect(report.offers).toMatchObject([{ network: 'base', amount: '1000', amountFormatted: '0.001 USDC' }]);
      expect(statusOf(report, 'offer[0].network')).toBe('pass');
      expect(statusOf(report, 'offer[0].asset')).toBe('pass');
      expect(statusOf(report, 'buyer.x402')).toBe('pass');
      // No header and no challenge in the body is still a failure.
      const none = await raw((_req, res) => { res.writeHead(402, { 'content-type': 'application/json' }); res.end('{"error":"pay"}'); });
      const failed402 = await checkSeller({ url: none });
      expect(failed402.checks.find((c) => c.id === 'x402')).toMatchObject({ status: 'fail', message: expect.stringMatching(/no PAYMENT-REQUIRED header and no x402 challenge in the JSON body/) });
    });

    it('warns that a v2 challenge in the body is off-spec', async () => {
      const { headers, challenge } = await realChallenge(false);
      const { 'payment-required': _drop, ...withoutHeader } = headers;
      const url = await raw((_req, res) => { res.writeHead(402, { ...withoutHeader, 'content-type': 'application/json' }); res.end(JSON.stringify(challenge)); });
      const report = await checkSeller({ url, facilitators: ['http://127.0.0.1:9'], timeoutMs: 1000 });
      expect(report.checks.find((c) => c.id === 'x402')).toMatchObject({ status: 'warn', message: expect.stringMatching(/JSON body, not the PAYMENT-REQUIRED header/) });
      expect(statusOf(report, 'buyer.x402')).toBe('pass');
    });

    it('compares amounts as numbers, not strings', async () => {
      const { fac, headers, challenge } = await realChallenge(false);
      challenge.accepts[0].amount = '01000';
      const url = await raw((_req, res) => { res.writeHead(402, { ...headers, 'payment-required': b64(challenge) }); res.end(); });
      const report = await checkSeller({ url, price: '$0.001', facilitators: [fac.url] });
      expect(statusOf(report, 'offer[0].amount')).toBe('pass');
    });

    it('lets an MPP challenge mirror a v1 offer', async () => {
      const facBase = await facilitator([[resolveNetwork('base').network, 'eip3009']]);
      const mppSeller = await seller({ network: 'base', facilitator: { url: facBase.url }, mpp: { secretKey: MPP_SECRET } });
      const mppRes = await fetch(`${mppSeller}/api/report`);
      const www = mppRes.headers.get('www-authenticate')!;
      expect(www).toMatch(/^Payment/);
      const url = await raw((req, res) => {
        res.writeHead(402, { 'content-type': 'application/json', 'www-authenticate': www });
        res.end(JSON.stringify(v1Challenge(`http://${req.headers.host}${req.url}`)));
      });
      const report = await checkSeller({ url, facilitators: [facBase.url] });
      expect(statusOf(report, 'mpp[0].mirror')).toBe('pass');
    });
  });

});
