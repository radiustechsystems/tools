#!/usr/bin/env node
/** Offline, executable x402 evaluation. All settlement in this file is simulated. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRadiusFetch, getPaymentReceipt, RadiusPaymentError } from '../../packages/sdk/dist/client/index.js';
import { resolveNetwork } from '../../packages/sdk/dist/index.js';
import { policyLedger } from './policy-ledger.mjs';
import { verifySignedPayment } from './signatures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'packages/cli/dist/index.js');
const NETWORK = resolveNetwork('testnet');
const PAY_TO = '0x000000000000000000000000000000000000dEaD';
const WRONG_ASSET = '0x000000000000000000000000000000000000bad0';
const FACILITATOR = '0x00000000000000000000000000000000fac11107';
const AMOUNT = '1000'; // 0.001 SBC
const TX_HASH = `0x${'ab'.repeat(32)}`;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const fromB64 = (value) => JSON.parse(Buffer.from(value, 'base64').toString());
const CASE_IDS = [
  'SDK-HAPPY', 'CLI-HAPPY', 'CLI-POST', 'CLI-DENY', 'SDK-WRONG-ASSET', 'SDK-WRONG-RECIPIENT',
  'SDK-WRONG-NETWORK', 'SDK-INVALID-CHALLENGE', 'SDK-MULTI-OFFER', 'SDK-V1', 'SDK-PERMIT2', 'SDK-UPTO',
  'SDK-UPTO-OVERCHARGE', 'SDK-REDIRECT', 'CLI-MISSING-RECEIPT', 'SDK-LOST-RESPONSE', 'SDK-PAID-5XX', 'SDK-REJECTED',
  'POLICY-CONCURRENT', 'POLICY-RESTART',
];
const AXES = {
  'SDK-HAPPY': ['selection', 'wire', 'evidence'], 'CLI-HAPPY': ['selection', 'wire', 'evidence'],
  'CLI-POST': ['wire', 'authority'], 'CLI-DENY': ['authority'], 'SDK-WRONG-ASSET': ['authority'],
  'SDK-WRONG-RECIPIENT': ['authority'], 'SDK-WRONG-NETWORK': ['authority'],
  'SDK-INVALID-CHALLENGE': ['selection', 'authority'], 'SDK-MULTI-OFFER': ['selection', 'wire'],
  'SDK-V1': ['wire'], 'SDK-PERMIT2': ['wire'], 'SDK-UPTO': ['selection', 'wire', 'evidence'],
  'SDK-UPTO-OVERCHARGE': ['evidence'], 'SDK-REDIRECT': ['authority', 'wire'],
  'CLI-MISSING-RECEIPT': ['evidence'], 'SDK-LOST-RESPONSE': ['recovery'],
  'SDK-PAID-5XX': ['recovery', 'evidence'], 'SDK-REJECTED': ['recovery'],
  'POLICY-CONCURRENT': ['authority', 'recovery'], 'POLICY-RESTART': ['authority', 'recovery'],
};

function offer(overrides = {}) {
  return {
    scheme: 'exact', network: NETWORK.network, asset: NETWORK.asset.address, payTo: PAY_TO,
    amount: AMOUNT, maxTimeoutSeconds: 60,
    extra: { name: NETWORK.asset.name, version: NETWORK.asset.version, assetTransferMethod: 'eip3009' },
    ...overrides,
  };
}

function challenge(url, accepts = [offer()], extras = {}) {
  return { x402Version: 2, resource: { url, description: 'One lookup', mimeType: 'application/json' }, accepts, ...extras };
}

function startServer(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveStart({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createFixture() {
  const configs = new Map();
  const traces = new Map();
  const ledger = new Map();
  const sinkRequests = [];
  let base;
  let sink;
  const put = (id, config = {}) => {
    configs.set(id, config);
    traces.set(id, []);
    ledger.delete(id);
    return `${base.url}/case/${id}`;
  };
  const reply = (res, status, headers, body) => {
    res.writeHead(status, headers);
    res.end(body);
  };
  return {
    put,
    trace: (id) => traces.get(id) ?? [],
    ledger: (id) => ledger.get(id),
    sinkRequests: () => sinkRequests,
    get rpcUrl() { return `${base.url}/rpc`; },
    async start() {
      sink = await startServer(async (req, res) => {
        sinkRequests.push({ method: req.method, paidHeader: Boolean(req.headers['payment-signature'] ?? req.headers['x-payment']) });
        await readBody(req);
        reply(res, 200, {}, 'redirected content');
      });
      base = await startServer(async (req, res) => {
        const path = new URL(req.url, base.url).pathname;
        if (path === '/rpc') {
          const raw = JSON.parse((await readBody(req)).toString());
          const answer = (call) => {
            if (call.method === 'eth_chainId') return { jsonrpc: '2.0', id: call.id, result: `0x${NETWORK.chainId.toString(16)}` };
            if (call.method === 'eth_call') {
              const selector = call.params?.[0]?.data?.slice(0, 10);
              const value = selector === '0xdd62ed3e' ? (2n ** 256n - 1n) : selector === '0x7ecebe00' ? 0n : 1_000_000_000n;
              return { jsonrpc: '2.0', id: call.id, result: `0x${value.toString(16).padStart(64, '0')}` };
            }
            return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `unsupported ${call.method}` } };
          };
          reply(res, 200, { 'content-type': 'application/json' }, JSON.stringify(Array.isArray(raw) ? raw.map(answer) : answer(raw)));
          return;
        }
        const id = path.split('/')[2];
        const config = configs.get(id);
        if (!config || !path.startsWith('/case/')) { reply(res, 404, {}, 'not found'); return; }
        const body = await readBody(req);
        const header = req.headers['payment-signature'] ?? req.headers['x-payment'];
        const trace = {
          method: req.method, path, body: body.toString(),
          paidHeader: Boolean(header),
          paymentHeaderName: req.headers['payment-signature'] ? 'payment-signature' : req.headers['x-payment'] ? 'x-payment' : null,
          authorizationPresent: Boolean(req.headers.authorization),
        };
        traces.get(id).push(trace);
        const url = `${base.url}${path}`;
        if (!header) {
          const data = config.challenge ?? challenge(url, config.accepts ?? [offer()]);
          if (data.x402Version === 1) reply(res, 402, { 'content-type': 'application/json' }, JSON.stringify(data));
          else reply(res, 402, { 'payment-required': b64(data), 'content-type': 'text/plain' }, config.untrustedText ?? 'payment required');
          return;
        }
        let payload;
        try { payload = fromB64(header); } catch { reply(res, 402, {}, 'bad payment'); return; }
        trace.x402Version = payload.x402Version;
        trace.acceptedAmount = payload.accepted?.amount ?? payload.payload?.authorization?.value;
        trace.payer = payload.payload?.authorization?.from ?? payload.payload?.permit2Authorization?.from;
        const accepts = (config.challenge ?? challenge(url, config.accepts ?? [offer()])).accepts;
        const accepted = accepts.find((entry) =>
          entry.network === (payload.accepted?.network ?? payload.network) &&
          entry.asset.toLowerCase() === (payload.accepted?.asset ?? entry.asset)?.toLowerCase() &&
          entry.payTo.toLowerCase() === (payload.accepted?.payTo ?? entry.payTo)?.toLowerCase() &&
          (entry.amount ?? entry.maxAmountRequired) === (payload.accepted?.amount ?? payload.payload?.authorization?.value ?? payload.payload?.permit2Authorization?.permitted?.amount) &&
          entry.scheme === (payload.accepted?.scheme ?? payload.scheme));
        try {
          if (![1, 2].includes(payload.x402Version) || !accepted || !/^0x[0-9a-f]{130}$/i.test(payload.payload?.signature ?? '')) throw new Error('bad envelope');
          trace.signatureValid = (await verifySignedPayment({ requirements: accepted, payload: payload.payload, chainId: NETWORK.chainId })).valid;
        } catch { trace.signatureValid = false; }
        if (!trace.signatureValid) { reply(res, 402, {}, 'invalid signed payment'); return; }
        if (config.paidMode === 'reject') { reply(res, 402, {}, 'payment rejected'); return; }
        if (config.paidMode === 'redirect') {
          reply(res, 307, { location: `${sink.url}/leak` }, '');
          return;
        }
        ledger.set(id, { simulatedSettlement: true, txHash: TX_HASH, payer: trace.payer,
          recipient: accepted.payTo, amount: config.receiptAmount ?? accepted.amount ?? accepted.maxAmountRequired });
        if (config.paidMode === 'lost') { req.socket.destroy(); return; }
        const headers = { 'content-type': 'application/json' };
        if (config.paidMode !== 'missingReceipt') {
          headers['payment-response'] = b64({ success: true, transaction: TX_HASH, network: NETWORK.network,
            payer: trace.payer, amount: config.receiptAmount ?? accepted.amount ?? accepted.maxAmountRequired });
        }
        reply(res, config.paidMode === 'handlerError' ? 500 : 200, headers,
          JSON.stringify(config.paidMode === 'handlerError' ? { error: 'delivery failed' } : { result: 'lookup complete', id }));
      });
    },
    async close() { await base?.close(); await sink?.close(); },
  };
}

function runCli(args, env, stdin = '') {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RADIUS_'))), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
    child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
    child.once('error', reject);
    // A CLI that exits before reading its input (EPIPE) fails this case rather than crashing the runner.
    let stdinError;
    child.stdin.on('error', (error) => { stdinError = error; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (stdinError && stdin) reject(new Error(`CLI exited ${code ?? signal} before reading its stdin: ${stdinError.message}`));
      else resolveRun({ code, signal, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function check(errors, label, assertion) {
  try { assertion(); } catch (error) { errors.push(`${label}: ${error.message}`); }
}

async function run() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) { process.stdout.write(`${CASE_IDS.join('\n')}\n`); return; }
  const only = args.includes('--case') ? args[args.indexOf('--case') + 1] : undefined;
  const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : join(ROOT, 'evaluations/agent-payments/results/latest.json');
  const fixture = createFixture();
  const home = await mkdtemp(join(tmpdir(), 'radius-payments-eval-'));
  await fixture.start();
  const env = { RADIUS_HOME: home, RADIUS_PASSWORD: 'local-eval-only', RADIUS_NETWORK: 'testnet', RADIUS_RPC_URL: fixture.rpcUrl };
  const sdk = () => createRadiusFetch({ network: 'testnet', rpcUrl: fixture.rpcUrl, signer: `0x${randomBytes(32).toString('hex')}`, maxPerRequest: { amount: '10000' } });
  const cliArgs = (url, extra = []) => ['--network', 'testnet', '--rpc-url', fixture.rpcUrl, '--json', 'wallet', 'pay', 'get', url, '--threshold', '0.01', '-y', ...extra];
  const cases = [];
  const execute = async (id, surface, fn) => {
    if (only && only !== id) return;
    const errors = [];
    try { await fn(errors); } catch (error) { errors.push(error.stack ?? String(error)); }
    const trace = fixture.trace(id).map(({ body, ...entry }) => ({
      ...entry, bodyBytes: Buffer.byteLength(body), bodySha256: createHash('sha256').update(body).digest('hex'),
    }));
    const scores = Object.fromEntries(['selection', 'authority', 'wire', 'recovery', 'evidence'].map((axis) =>
      [axis, AXES[id]?.includes(axis) ? errors.length ? 0 : axis === 'evidence' ? 1 : 2 : null]));
    cases.push({ id, surface, pass: errors.length === 0, errors, scores, trace,
      simulatedSettlement: Boolean(fixture.ledger(id)), verifiedNetworkSettlement: false });
    process.stdout.write(`${errors.length ? 'FAIL' : 'PASS'} ${id}\n`);
    if (errors.length) process.stderr.write(`${errors.join('\n')}\n`);
  };
  try {
    const address = await runCli(['--json', 'wallet', 'address'], env);
    assert.equal(address.code, 0, address.stderr);

    await execute('SDK-HAPPY', 'sdk', async (errors) => {
      const url = fixture.put('SDK-HAPPY');
      const buyer = sdk();
      const res = await buyer(url);
      const receipt = getPaymentReceipt(res, buyer.network);
      check(errors, 'status', () => assert.equal(res.status, 200));
      check(errors, 'seller receipt', () => assert.equal(receipt?.success, true));
      check(errors, 'wire', () => assert.deepEqual(fixture.trace('SDK-HAPPY').map((r) => r.paidHeader), [false, true]));
      check(errors, 'signed authorization', () => assert.equal(fixture.trace('SDK-HAPPY')[1]?.signatureValid, true));
      check(errors, 'simulated ledger', () => assert.equal(fixture.ledger('SDK-HAPPY')?.amount, AMOUNT));
      const body = await res.json();
      check(errors, 'delivery', () => assert.equal(body.result, 'lookup complete'));
    });

    await execute('CLI-HAPPY', 'cli', async (errors) => {
      const url = fixture.put('CLI-HAPPY');
      const result = await runCli(cliArgs(url), env);
      check(errors, 'exit', () => assert.equal(result.code, 0, result.stderr));
      const parsed = JSON.parse(result.stdout);
      check(errors, 'status', () => assert.equal(parsed.status, 200));
      check(errors, 'seller receipt label', () => assert.equal(parsed.payment.paid, true));
      check(errors, 'wire', () => assert.deepEqual(fixture.trace('CLI-HAPPY').map((r) => r.paidHeader), [false, true]));
      check(errors, 'signed authorization', () => assert.equal(fixture.trace('CLI-HAPPY')[1]?.signatureValid, true));
    });

    await execute('CLI-POST', 'cli', async (errors) => {
      const url = fixture.put('CLI-POST');
      const argsPost = cliArgs(url);
      argsPost[argsPost.indexOf('get')] = 'post';
      argsPost.push('-d', '-', '-H', 'Content-Type: application/json', '-H', 'PAYMENT-SIGNATURE: stale');
      const result = await runCli(argsPost, env, '{"question":"price?"}');
      check(errors, 'exit', () => assert.equal(result.code, 0, result.stderr));
      check(errors, 'method and body', () => assert.deepEqual(fixture.trace('CLI-POST').map((r) => [r.method, r.body]), [['POST', '{"question":"price?"}'], ['POST', '{"question":"price?"}']]));
      check(errors, 'caller payment header stripped', () => assert.deepEqual(fixture.trace('CLI-POST').map((r) => r.paidHeader), [false, true]));
    });

    await execute('CLI-DENY', 'cli', async (errors) => {
      const url = fixture.put('CLI-DENY', { accepts: [offer({ amount: '10001' })] });
      const result = await runCli(cliArgs(url), env);
      check(errors, 'refusal exit', () => assert.equal(result.code, 2, result.stderr));
      check(errors, 'no paid retry', () => assert.deepEqual(fixture.trace('CLI-DENY').map((r) => r.paidHeader), [false]));
      check(errors, 'no settlement', () => assert.equal(fixture.ledger('CLI-DENY'), undefined));
    });

    await execute('SDK-WRONG-ASSET', 'sdk', async (errors) => {
      const url = fixture.put('SDK-WRONG-ASSET', { accepts: [offer({ asset: WRONG_ASSET })] });
      await assert.rejects(sdk()(url), (e) => e instanceof RadiusPaymentError && e.code === 'asset_mismatch');
      check(errors, 'no paid retry', () => assert.deepEqual(fixture.trace('SDK-WRONG-ASSET').map((r) => r.paidHeader), [false]));
    });

    await execute('SDK-WRONG-RECIPIENT', 'sdk', async (errors) => {
      const url = fixture.put('SDK-WRONG-RECIPIENT', { accepts: [offer({ payTo: WRONG_ASSET })] });
      const guarded = createRadiusFetch({
        network: 'testnet', rpcUrl: fixture.rpcUrl, signer: `0x${randomBytes(32).toString('hex')}`,
        maxPerRequest: { amount: '10000' }, onPaymentRequired: (selected) => selected.payTo.toLowerCase() === PAY_TO.toLowerCase(),
      });
      await assert.rejects(guarded(url), (e) => e instanceof RadiusPaymentError && e.code === 'declined');
      check(errors, 'no paid retry', () => assert.deepEqual(fixture.trace('SDK-WRONG-RECIPIENT').map((r) => r.paidHeader), [false]));
    });

    await execute('SDK-WRONG-NETWORK', 'sdk', async (errors) => {
      const url = fixture.put('SDK-WRONG-NETWORK', { accepts: [offer({ network: 'eip155:723487' })] });
      await assert.rejects(sdk()(url), (e) => e instanceof RadiusPaymentError && e.code === 'network_mismatch');
      check(errors, 'no paid retry', () => assert.deepEqual(fixture.trace('SDK-WRONG-NETWORK').map((r) => r.paidHeader), [false]));
    });

    await execute('SDK-INVALID-CHALLENGE', 'sdk', async (errors) => {
      const url = fixture.put('SDK-INVALID-CHALLENGE', { challenge: { x402Version: 2, accepts: [] } });
      await assert.rejects(sdk()(url), (e) => e instanceof RadiusPaymentError && e.code === 'invalid_challenge');
      check(errors, 'no paid retry', () => assert.deepEqual(fixture.trace('SDK-INVALID-CHALLENGE').map((r) => r.paidHeader), [false]));
    });

    await execute('SDK-MULTI-OFFER', 'sdk', async (errors) => {
      const url = fixture.put('SDK-MULTI-OFFER', { accepts: [offer({ asset: WRONG_ASSET }), offer({ amount: '20000' }), offer({ amount: '1000' })] });
      const res = await sdk()(url);
      check(errors, 'affordable offer selected', () => assert.equal(fixture.trace('SDK-MULTI-OFFER')[1]?.acceptedAmount, '1000'));
      check(errors, 'delivered', () => assert.equal(res.status, 200));
    });

    await execute('SDK-V1', 'sdk', async (errors) => {
      const url = fixture.put('SDK-V1', { challenge: { x402Version: 1, accepts: [{
        scheme: 'exact', network: NETWORK.network, asset: NETWORK.asset.address, payTo: PAY_TO,
        maxAmountRequired: AMOUNT, resource: '/case/SDK-V1', description: 'Legacy lookup', mimeType: 'application/json',
        maxTimeoutSeconds: 60, extra: { name: NETWORK.asset.name, version: NETWORK.asset.version },
      }] } });
      const res = await sdk()(url);
      check(errors, 'delivery', () => assert.equal(res.status, 200));
      check(errors, 'legacy header', () => assert.equal(fixture.trace('SDK-V1')[1]?.paymentHeaderName, 'x-payment'));
      check(errors, 'signed legacy authorization', () => assert.equal(fixture.trace('SDK-V1')[1]?.signatureValid, true));
    });

    await execute('SDK-PERMIT2', 'sdk', async (errors) => {
      const url = fixture.put('SDK-PERMIT2', { accepts: [offer({ extra: { name: NETWORK.asset.name, version: NETWORK.asset.version, assetTransferMethod: 'permit2' } })] });
      const res = await sdk()(url);
      check(errors, 'delivery', () => assert.equal(res.status, 200));
      check(errors, 'signed Permit2 authorization', () => assert.equal(fixture.trace('SDK-PERMIT2')[1]?.signatureValid, true));
    });

    await execute('SDK-UPTO', 'sdk', async (errors) => {
      const url = fixture.put('SDK-UPTO', { accepts: [offer({ scheme: 'upto', amount: '5000',
        extra: { name: NETWORK.asset.name, version: NETWORK.asset.version, facilitatorAddress: FACILITATOR } })], receiptAmount: '2000' });
      const buyer = sdk();
      const res = await buyer(url);
      check(errors, 'delivery', () => assert.equal(res.status, 200));
      check(errors, 'signed upto authorization', () => assert.equal(fixture.trace('SDK-UPTO')[1]?.signatureValid, true));
      check(errors, 'partial simulated charge', () => assert.equal(getPaymentReceipt(res, buyer.network)?.amount, '2000'));
    });

    await execute('SDK-UPTO-OVERCHARGE', 'sdk', async (errors) => {
      const url = fixture.put('SDK-UPTO-OVERCHARGE', { accepts: [offer({ scheme: 'upto', amount: '5000',
        extra: { name: NETWORK.asset.name, version: NETWORK.asset.version, facilitatorAddress: FACILITATOR } })], receiptAmount: '5001' });
      await assert.rejects(sdk()(url), (e) => e instanceof RadiusPaymentError && e.code === 'invalid_receipt');
      check(errors, 'one signed retry', () => assert.deepEqual(fixture.trace('SDK-UPTO-OVERCHARGE').map((r) => r.paidHeader), [false, true]));
    });

    await execute('SDK-REDIRECT', 'sdk', async (errors) => {
      // A redirect after payment is followed by fetch's rules, never with the payment header.
      const url = fixture.put('SDK-REDIRECT', { paidMode: 'redirect' });
      const seen = fixture.sinkRequests().length;
      const res = await sdk()(url);
      const followed = fixture.sinkRequests().slice(seen);
      check(errors, 'redirect followed once', () => assert.equal(followed.length, 1));
      check(errors, 'header did not reach other origin', () => assert.equal(followed[0]?.paidHeader, false));
      const body = await res.text();
      check(errors, 'delivered', () => assert.equal(body, 'redirected content'));
      check(errors, 'one paid retry', () => assert.deepEqual(fixture.trace('SDK-REDIRECT').map((r) => r.paidHeader), [false, true]));
    });

    await execute('CLI-MISSING-RECEIPT', 'cli', async (errors) => {
      const url = fixture.put('CLI-MISSING-RECEIPT', { paidMode: 'missingReceipt' });
      const result = await runCli(cliArgs(url), env);
      const parsed = JSON.parse(result.stdout);
      check(errors, 'HTTP exit', () => assert.equal(result.code, 0));
      check(errors, 'seller claim absent', () => assert.equal(parsed.payment.paid, false));
      check(errors, 'warning', () => assert.match(result.stderr, /settlement was not confirmed/));
      check(errors, 'simulated settlement remains distinct', () => assert.equal(fixture.ledger('CLI-MISSING-RECEIPT')?.simulatedSettlement, true));
    });

    await execute('SDK-LOST-RESPONSE', 'sdk', async (errors) => {
      const url = fixture.put('SDK-LOST-RESPONSE', { paidMode: 'lost' });
      await assert.rejects(sdk()(url));
      check(errors, 'simulated seller settled', () => assert.equal(fixture.ledger('SDK-LOST-RESPONSE')?.simulatedSettlement, true));
      check(errors, 'no blind retry', () => assert.deepEqual(fixture.trace('SDK-LOST-RESPONSE').map((r) => r.paidHeader), [false, true]));
    });

    await execute('SDK-PAID-5XX', 'sdk', async (errors) => {
      const url = fixture.put('SDK-PAID-5XX', { paidMode: 'handlerError' });
      const buyer = sdk();
      const res = await buyer(url);
      check(errors, 'delivery failed', () => assert.equal(res.status, 500));
      check(errors, 'seller receipt present', () => assert.equal(getPaymentReceipt(res, buyer.network)?.success, true));
      check(errors, 'one paid retry', () => assert.equal(fixture.trace('SDK-PAID-5XX').length, 2));
    });

    await execute('SDK-REJECTED', 'sdk', async (errors) => {
      const url = fixture.put('SDK-REJECTED', { paidMode: 'reject' });
      await assert.rejects(sdk()(url), (e) => e instanceof RadiusPaymentError && e.code === 'payment_rejected');
      check(errors, 'no simulated settlement', () => assert.equal(fixture.ledger('SDK-REJECTED'), undefined));
    });

    await execute('POLICY-CONCURRENT', 'policy-fixture', async (errors) => {
      const ledger = policyLedger(join(home, 'concurrent.json'), '1500');
      const binding = { url: 'https://seller.eval.local/api/lookup', network: NETWORK.network, asset: NETWORK.asset.address, payTo: PAY_TO };
      const [first, second] = await Promise.all([ledger.reserve('task-a', '1000', binding), ledger.reserve('task-b', '1000', binding)]);
      check(errors, 'one reservation and one denial', () => assert.deepEqual([first.state, second.state].sort(), ['denied', 'reserved']));
      const state = await ledger.inspect();
      check(errors, 'budget cannot overspend', () => assert.equal(Object.values(state.entries).reduce((sum, entry) => sum + BigInt(entry.amount), 0n), 1000n));
    });

    await execute('POLICY-RESTART', 'policy-fixture', async (errors) => {
      const path = join(home, 'restart.json');
      const first = policyLedger(path, '1500');
      const binding = { url: 'https://seller.eval.local/api/lookup', network: NETWORK.network, asset: NETWORK.asset.address, payTo: PAY_TO };
      await first.reserve('task-1', '1000', binding);
      await first.transition('task-1', 'reserved', 'unknown');
      const reopened = policyLedger(path, '1500');
      const replay = await reopened.reserve('task-1', '1000', binding);
      check(errors, 'unknown outcome is reused without new reservation', () => assert.deepEqual([replay.state, replay.reused], ['unknown', true]));
      await assert.rejects(reopened.reserve('task-1', '1001', binding), /different offer/);
      await assert.rejects(reopened.transition('task-1', 'unknown', 'settled', { transaction: TX_HASH }), /reconciled transaction marker/);
      await reopened.transition('task-1', 'unknown', 'settled', { transaction: TX_HASH, simulatedVerified: true });
      const final = await reopened.reserve('task-1', '1000', binding);
      await assert.rejects(reopened.transition('task-1', 'settled', 'released'), /Illegal evaluation transition/);
      const persisted = await reopened.inspect();
      check(errors, 'settled outcome survives restart', () => assert.deepEqual([final.state, final.reused, final.transaction], ['settled', true, TX_HASH]));
      check(errors, 'one durable task entry', () => assert.equal(Object.keys(persisted.entries).length, 1));
    });
  } finally {
    await fixture.close();
    await rm(home, { recursive: true, force: true });
  }
  if (only && cases.length === 0) throw new Error(`Unknown case: ${only}`);
  const report = {
    suite: 'agent-payments-offline', scenarioVersion: 1,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    dirtyCheckout: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0,
    generatedAt: new Date().toISOString(), network: NETWORK.network,
    simulatedOnly: true, verifiedNetworkSettlement: false,
    total: cases.length, passed: cases.filter((c) => c.pass).length, failed: cases.filter((c) => !c.pass).length, cases,
  };
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\n${report.passed}/${report.total} passed. Report: ${resolve(output)}\n`);
  if (report.failed) process.exitCode = 1;
}

run().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
