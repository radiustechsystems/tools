#!/usr/bin/env node
/**
 * Offline seller-side evaluation. Every case runs the real radius-sdk seller (`radiusPayments`,
 * the Hono middleware, or `createRadiusServer` behind the upstream `@x402/express` adapter) over
 * loopback HTTP and pays it with the real SDK buyer or CLI. Facilitators are local mocks that check
 * signatures and consume nonces (mock-facilitator.mjs); all settlement in this file is simulated.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRadiusFetch, getPaymentReceipt, RadiusPaymentError } from '../../packages/sdk/dist/client/index.js';
import { resolveNetwork } from '../../packages/sdk/dist/index.js';
import { radiusPayments as honoPayments } from '../../packages/sdk/dist/hono/index.js';
import { encodeRequest, parseMppChallenges, parseMppCredential, parseMppReceipt, serializeMppCredential } from '../../packages/sdk/dist/mpp.js';
import { createRadiusServer, radiusPayments } from '../../packages/sdk/dist/server/index.js';
import { createMockFacilitator } from './mock-facilitator.mjs';
import { prepareApp, provision, run as runAsync, startProcess, cleanEnv, Unavailable } from './sell-frameworks.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HERE = join(ROOT, 'evaluations/agent-payments');
const CLI = join(ROOT, 'packages/cli/dist/index.js');
const SDK_MODULES = join(ROOT, 'packages/sdk/node_modules');

/** ESM entry of a package installed for the SDK (express, hono, @x402/express are its dev dependencies). */
async function importFromSdk(name) {
  const dir = join(SDK_MODULES, name);
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const entry = pkg.exports?.['.'] ?? pkg.exports ?? pkg.main ?? 'index.js';
  const pick = (e) => (typeof e === 'string' ? e : pick(e.import ?? e.default));
  return import(pathToFileURL(join(dir, pick(entry))).href);
}
const express = (await importFromSdk('express')).default;
const { paymentMiddleware } = await importFromSdk('@x402/express');
const { Hono } = await importFromSdk('hono');

const TESTNET = resolveNetwork('testnet');
const BASE_SEPOLIA = resolveNetwork('base-sepolia');
const PAY_TO = '0x1eF420190c299D4d133fE9227F780D7d5cE91BeE';
const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';
const ATTACKER = '0x000000000000000000000000000000000000bad0';
const SECRET_KEY = 'eval-only-mpp-secret-0123456789abcdef0123';
const OTHER_SECRET_KEY = 'eval-only-mpp-secret-fedcba9876543210fedc';
const REALM = 'seller.eval.local';
const ADAPTERS = ['web', 'hono', 'express'];
/** Adapters that serve MPP. The upstream @x402/express adapter only sees x402 (a known gap; see SELL-CHALLENGE). */
const MPP_ADAPTERS = ['web', 'hono'];
const RADIUS_KIND = { network: TESTNET.network, chainId: TESTNET.chainId, methods: ['eip3009', 'permit2'],
  extra: { name: TESTNET.asset.name, version: TESTNET.asset.version } };
const BASE_KIND = { network: BASE_SEPOLIA.network, chainId: BASE_SEPOLIA.chainId, methods: ['eip3009'] };
const CASE_IDS = ['SELL-ONESHOT', 'SELL-CHALLENGE', 'SELL-DUAL', 'SELL-MULTI-NET', 'SELL-FACILITATOR', 'SELL-REPLAY', 'SELL-ORDER', 'SELL-ROUTING',
  'SELL-NEXT-MW', 'SELL-ASTRO-MW', 'SELL-WORKER-PROXY', 'SELL-SELECTIVE'];
/** Framework versions the SELL-NEXT-MW and SELL-ASTRO-MW cases provision on demand (see sell-frameworks.mjs). */
const NEXT_DEPS = { next: '15.5.27', react: '19.1.1', 'react-dom': '19.1.1' };
const ASTRO_TARGETS = [
  { name: 'astro4', deps: { astro: '4.15.12', '@astrojs/node': '8.3.4' }, guard: 'middleware.astro4.js' },
  { name: 'astro5', deps: { astro: '5.18.1', '@astrojs/node': '9.5.4' }, guard: 'middleware.astro5.js' },
];
const PUBLIC_HOST = 'www.example-publisher.test';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const fromB64 = (value) => JSON.parse(Buffer.from(value, 'base64').toString());
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const challengeOf = (res) => fromB64(res.headers.get('payment-required'));
const randomKey = () => `0x${randomBytes(32).toString('hex')}`;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// -- local HTTP ------------------------------------------------------------------------------

function listen(server) {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => done({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((closed) => { server.closeAllConnections(); server.close(closed); }),
    }));
  });
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

/** Serve a web-standard `Request → Response` function over node:http, keeping the raw request path. */
function serveFetch(fetchFn) {
  return listen(createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = Object.entries(req.headers).filter(([key]) => !HOP_BY_HOP.has(key));
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
    let response;
    try {
      response = await fetchFn(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`unhandled: ${error.message}`);
      return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }));
}

/** A request whose path is sent byte-for-byte (fetch would normalize `.` and `..` segments). */
function rawRequest(base, path, { method = 'GET', headers = {} } = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((done, fail) => {
    const req = httpRequest({ hostname, port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, headers: new Headers(Object.entries(res.headers).map(([k, v]) => [k, String(v)])), text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', fail);
    req.end();
  });
}

/** A buyer `fetch` that sends every request to `base` + `path` unnormalized, whatever URL it is given. */
function rawPathFetch(base, path) {
  return async (input, init) => {
    const request = new Request(input, init);
    const r = await rawRequest(base, path, { method: request.method, headers: Object.fromEntries(request.headers) });
    return new Response(r.text, { status: r.status, headers: r.headers });
  };
}

async function read(res) {
  return { status: res.status, headers: res.headers, text: await res.text() };
}

function startRpc() {
  return listen(createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const chainId = Number(new URL(req.url, 'http://rpc').pathname.slice(1));
    const raw = JSON.parse(Buffer.concat(chunks).toString());
    const answer = (call) => {
      if (call.method === 'eth_chainId') return { jsonrpc: '2.0', id: call.id, result: `0x${chainId.toString(16)}` };
      if (call.method === 'eth_call') {
        const selector = call.params?.[0]?.data?.slice(0, 10);
        const value = selector === '0xdd62ed3e' ? (2n ** 256n - 1n) : selector === '0x7ecebe00' ? 0n : 1_000_000_000n;
        return { jsonrpc: '2.0', id: call.id, result: `0x${value.toString(16).padStart(64, '0')}` };
      }
      return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `unsupported ${call.method}` } };
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(raw) ? raw.map(answer) : answer(raw)));
  }));
}

// -- sellers ---------------------------------------------------------------------------------

/** How dynamic `price`/`payTo` functions reach the request URL under each adapter's context type. */
const URL_OF = {
  web: (request) => new URL(request.url),
  hono: (c) => new URL(c.req.url),
  express: (context) => new URL(context.adapter.getUrl()),
};

/**
 * Register framework-neutral handlers (`'GET /path/:param' → ({ url, params, payment }) → { status, json, headers }`)
 * on a Hono app, counting invocations in `hits`.
 */
function honoRouter(app, handlers, hits, paymentOf) {
  for (const [key, handler] of Object.entries(handlers)) {
    const [method, path] = key.split(' ');
    app.on(method, path, async (c) => {
      hits[key] = (hits[key] ?? 0) + 1;
      const out = await handler({ url: new URL(c.req.url), params: c.req.param(), payment: paymentOf(c) });
      return c.json(out.json, out.status ?? 200, out.headers);
    });
  }
  return app;
}

/**
 * Start one seller: `web` is `radiusPayments().wrap()` over a plain fetch router (handler errors
 * propagate to the SDK), `hono` is the `radius-sdk/hono` middleware, `express` is
 * `createRadiusServer` with `@x402/express`. `routes` may be a function of `URL_OF[kind]`.
 */
async function startSeller(kind, { options, payTo = PAY_TO, routes, handlers }) {
  const hits = {};
  const routeSpecs = typeof routes === 'function' ? routes(URL_OF[kind]) : routes;
  const payToSpec = typeof payTo === 'function' ? payTo(URL_OF[kind]) : payTo;
  let served;
  if (kind === 'web') {
    const router = honoRouter(new Hono(), handlers, hits, (c) => c.env?.payment);
    router.onError((error) => { throw error; });
    const pay = radiusPayments({ ...options, payTo: payToSpec, routes: routeSpecs });
    served = await serveFetch(pay.wrap((request, payment) => router.fetch(request, { payment })));
  } else if (kind === 'hono') {
    const app = new Hono();
    app.onError((_error, c) => c.text('Internal Server Error', 500)); // Hono's default, without the log line
    app.use(honoPayments({ ...options, payTo: payToSpec, routes: routeSpecs }));
    honoRouter(app, handlers, hits, (c) => c.get('radiusPayment'));
    served = await serveFetch((request) => app.fetch(request));
  } else {
    const radius = createRadiusServer(options);
    const app = express();
    app.set('env', 'test'); // keeps the default error handler from logging stack traces
    app.use(paymentMiddleware(radius.routes({ payTo: payToSpec, routes: routeSpecs }), radius.server));
    for (const [key, handler] of Object.entries(handlers)) {
      const [method, path] = key.split(' ');
      app[method.toLowerCase()](path, async (req, res) => {
        hits[key] = (hits[key] ?? 0) + 1;
        const out = await handler({ url: new URL(req.originalUrl, 'http://seller'), params: req.params });
        res.status(out.status ?? 200).set(out.headers ?? {}).json(out.json);
      });
    }
    served = await listen(createServer(app));
  }
  return { ...served, kind, hits, hitsOf: (key) => hits[key] ?? 0 };
}

/** A paid handler whose body and `x-content-id` header both carry the protected marker. */
const content = (name) => () => ({ json: { content: `CONTENT:${name}` }, headers: { 'x-content-id': `CONTENT:${name}` } });
/** Protected content in any response header. */
const headerLeaks = ({ headers }) => [...headers.values()].some((v) => v.includes('CONTENT:'));
const REPORT_ROUTE = { 'GET /api/report': { price: '$0.001', description: 'Quarterly report', mimeType: 'application/json' } };
const REPORT_HANDLERS = { 'GET /api/report': content('report'), 'GET /health': () => ({ json: { ok: true } }) };

// -- buyers ----------------------------------------------------------------------------------

let rpcUrl;

function buyer({ network = 'testnet', ...rest } = {}) {
  return createRadiusFetch({
    network, rpcUrl: `${rpcUrl}/${resolveNetwork(network).chainId}`, signer: randomKey(),
    maxPerRequest: { amount: '100000' }, preferFunded: false, ...rest,
  });
}

/** The payment header of a request (x402 `PAYMENT-SIGNATURE` or an MPP `Authorization: Payment`). */
function paymentHeaderOf(request) {
  const mpp = request.headers.get('authorization');
  return request.headers.get('payment-signature') ?? (/^payment\s/i.test(mpp ?? '') ? mpp : undefined);
}

/** A buyer `fetch` that records each paid request's header; with `hold`, the paid request never reaches the seller. */
function recorder({ hold = false } = {}) {
  const sent = [];
  return {
    sent,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const header = paymentHeaderOf(request);
      if (header) {
        sent.push(header);
        if (hold) return new Response(null, { status: 204 });
      }
      return fetch(request);
    },
  };
}

/** A signed payment for `url`, made by the real buyer but not submitted. */
async function heldPayment(url, options = {}) {
  const rec = recorder({ hold: true });
  await buyer({ ...options, fetch: rec.fetch })(url);
  assert.equal(rec.sent.length, 1, 'buyer produced one payment header');
  return rec.sent[0];
}

function submit(url, header, init = {}) {
  const name = /^payment\s/i.test(header) ? 'authorization' : 'payment-signature';
  return fetch(url, { ...init, headers: { ...init.headers, [name]: header } });
}

/** The inherited environment minus `RADIUS_*`, so a developer's wallet settings cannot leak into the CLI under test. */
function withoutRadiusEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RADIUS_')));
}

function runCli(args, env) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...withoutRadiusEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
    child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
    child.once('error', fail);
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

// -- one-shot integration --------------------------------------------------------------------

/** The packages a fresh app of each framework has, as `npm i radius-sdk …` would provide them. Only these are linked and listed. */
const ONESHOT_PACKAGES = { express: ['express', '@x402/express', '@x402/core', 'viem'], hono: ['hono', 'viem'] };
/** The one-shot task, shared with the Claude plugin eval of the same name (its frontmatter is for that runner). */
const ONESHOT_PROMPT = join(ROOT, 'plugins/radius/evals/sell-oneshot/prompt.md');

/** A fresh seller app: a `package.json` naming the framework (the integrator detects it from there) and its `node_modules`. */
async function scaffoldApp(framework) {
  const dir = await mkdtemp(join(tmpdir(), `radius-sell-oneshot-${framework}-`));
  const packages = { 'radius-sdk': join(ROOT, 'packages/sdk') };
  for (const name of ONESHOT_PACKAGES[framework]) packages[name] = await realpath(join(SDK_MODULES, name));
  for (const [name, target] of Object.entries(packages)) {
    await mkdir(dirname(join(dir, 'node_modules', name)), { recursive: true });
    await symlink(target, join(dir, 'node_modules', name), 'dir');
  }
  const dependencies = Object.fromEntries(await Promise.all(Object.entries(packages).map(async ([name, target]) =>
    [name, JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).version])));
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name: `oneshot-${framework}-seller`, private: true, type: 'module', dependencies }, null, 2)}\n`);
  return dir;
}

/** Fill `dir` with a seller app: the reference fixture, or whatever `SELL_INTEGRATOR_CMD` writes from the prompt. */
async function integrate(framework, dir) {
  const command = process.env.SELL_INTEGRATOR_CMD;
  if (!command) {
    await cp(join(HERE, 'fixtures/sell-oneshot', framework), dir, { recursive: true });
    return { integrator: 'reference' };
  }
  // This scaffold has a real manifest: the agent must detect its framework rather than use the prompt's read-only fallback.
  const prompt = (await readFile(ONESHOT_PROMPT, 'utf8')).replace(/^---\n[\s\S]*?\n---\n/, '');
  const promptFile = join(dir, 'PROMPT.md');
  await writeFile(promptFile, prompt);
  // The agent gets no Radius wallet configuration: it writes code, it never pays.
  const env = withoutRadiusEnv();
  Object.assign(env, { SELL_FRAMEWORK: framework, SELL_APP_DIR: dir, SELL_PROMPT_FILE: promptFile, SELL_REPO_ROOT: ROOT });
  const timeoutMs = Number(process.env.SELL_INTEGRATOR_TIMEOUT_MS ?? 900_000);
  const result = await new Promise((done, fail) => {
    // Own process group, so the timeout can kill the shell and everything it started.
    const child = spawn(command, { shell: true, detached: true, cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (s) => { output = (output + s).slice(-4000); };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    child.once('error', fail);
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }, timeoutMs);
    child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal, outputTail: output }); });
  });
  return { integrator: 'command', ...result };
}

async function freePort() {
  const { url, close } = await listen(createServer());
  await close();
  return Number(new URL(url).port);
}

/** Boot `server.ts` with type stripping and wait for `/health`. */
async function bootApp(dir, env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server.ts'], {
    cwd: dir, env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1', PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const keep = (s) => { output = (output + s).slice(-4000); };
  child.stdout.setEncoding('utf8').on('data', keep);
  child.stderr.setEncoding('utf8').on('data', keep);
  let exited = false;
  child.once('exit', () => { exited = true; });
  const url = `http://127.0.0.1:${port}`;
  const stop = () => { if (!exited) child.kill('SIGKILL'); };
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && !exited;) {
    try {
      if ((await fetch(`${url}/health`)).status === 200) return { url, stop, output: () => output };
    } catch { /* not listening yet */ }
    await sleep(200);
  }
  stop();
  throw new Error(`app did not answer GET /health with 200 within 30s${exited ? ' (process exited)' : ''}: ${output.slice(-800)}`);
}

// -- runner ----------------------------------------------------------------------------------

async function run() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) { process.stdout.write(`${CASE_IDS.join('\n')}\n`); return; }
  const only = args.includes('--case') ? args[args.indexOf('--case') + 1] : undefined;
  if (args.includes('--skip-provisioned')) process.env.SELL_SKIP_PROVISIONED = '1'; // use frameworks already cached; never install
  if (only && !CASE_IDS.includes(only)) throw new Error(`Unknown case: ${only}`);
  const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : join(HERE, 'results/sell.json');
  const rpc = await startRpc();
  rpcUrl = rpc.url;
  const home = await mkdtemp(join(tmpdir(), 'radius-sell-eval-'));
  const cliEnv = { RADIUS_HOME: home, RADIUS_PASSWORD: 'local-eval-only', RADIUS_NETWORK: 'testnet', RADIUS_RPC_URL: `${rpcUrl}/${TESTNET.chainId}` };
  const cases = [];

  const execute = async (id, fn) => {
    if (only && only !== id) return;
    const errors = [];
    const xfails = [];
    const skips = [];
    let graded = 0;
    const observations = {};
    const closers = [];
    const t = {
      /** A hard assertion. */
      check: async (label, assertion) => {
        graded++;
        try { await assertion(); } catch (error) { errors.push(`${label}: ${error.message}`); }
      },
      /**
       * A known SDK gap: the assertion states the correct behavior and is expected to fail today.
       * If it starts passing, the case fails so the marker gets removed.
       */
      known: async (label, reason, assertion) => {
        graded++;
        try {
          await assertion();
          errors.push(`${label}: expected failure no longer reproduces (${reason}); remove the XFAIL marker`);
        } catch (error) { xfails.push({ label, reason, detail: error.message }); }
      },
      observe: (key, value) => { observations[key] = value; },
      /**
       * Part of a case could not run here (a framework that cannot be installed offline). It is reported as SKIP, not a
       * failure. A case where nothing else was graded is a SKIP as a whole.
       */
      skip: (label, reason) => { skips.push({ label, reason }); },
      facilitator: async (options) => {
        const f = await createMockFacilitator(options).start();
        closers.push(f.close);
        return f;
      },
      seller: async (kind, spec) => {
        const s = await startSeller(kind, spec);
        closers.push(s.close);
        return s;
      },
      defer: (close) => closers.push(close),
    };
    try { await fn(t); } catch (error) { errors.push(error.stack ?? String(error)); }
    for (const close of closers.reverse()) await close().catch(() => {});
    const status = errors.length ? 'fail' : skips.length && !graded ? 'skip' : xfails.length ? 'xfail' : 'pass';
    cases.push({ id, status, pass: status !== 'fail', errors, xfails, skips, observations, simulatedSettlement: true, verifiedNetworkSettlement: false });
    for (const x of xfails) process.stdout.write(`XFAIL ${id}: ${x.label}: ${x.reason}\n`);
    for (const x of skips) process.stdout.write(`SKIP ${id}: ${x.label}: ${x.reason}\n`);
    process.stdout.write(`${{ fail: 'FAIL', skip: 'SKIP', xfail: 'XFAIL', pass: 'PASS' }[status]} ${id}\n`);
    if (errors.length) process.stderr.write(`${errors.join('\n')}\n`);
  };

  const radiusFacilitator = (t, overrides = {}) => t.facilitator({ name: 'radius-testnet', networks: [RADIUS_KIND], extensions: ['eip2612GasSponsoring'], ...overrides });

  try {
    if (!only || only === 'SELL-ONESHOT') {
      const address = await runCli(['--json', 'wallet', 'address'], cliEnv);
      assert.equal(address.code, 0, address.stderr);
    }

    await execute('SELL-ONESHOT', async (t) => {
      for (const framework of ['express', 'hono']) {
        const at = `[${framework}]`;
        const fac = await radiusFacilitator(t);
        const dir = await scaffoldApp(framework);
        t.defer(() => rm(dir, { recursive: true, force: true }));
        const integration = await integrate(framework, dir);
        t.observe(`${framework}.integration`, integration);
        let app;
        try {
          app = await bootApp(dir, { PAY_TO, RADIUS_FACILITATOR_URL: fac.url });
        } catch (error) {
          await t.check(`${at} boot`, () => { throw error; });
          continue;
        }
        t.defer(async () => app.stop());
        const url = `${app.url}/api/report`;

        const unpaid = await read(await fetch(url));
        await t.check(`${at} unpaid request gets a 402 without content`, () => {
          assert.equal(unpaid.status, 402);
          assert.doesNotMatch(unpaid.text, /quarterly-sales/);
        });
        await t.check(`${at} challenge names the configured offer`, () => {
          const [offer] = challengeOf(unpaid).accepts;
          assert.equal(offer.network, TESTNET.network);
          assert.ok(same(offer.asset, TESTNET.asset.address));
          assert.ok(same(offer.payTo, PAY_TO));
          assert.equal(offer.amount, '1000');
        });

        const happy = recorder();
        const res = await buyer({ fetch: happy.fetch })(url);
        const delivered = await read(res);
        await t.check(`${at} buyer happy path`, () => {
          assert.equal(delivered.status, 200);
          assert.match(delivered.text, /quarterly-sales/);
          assert.equal(getPaymentReceipt(res, TESTNET)?.success, true);
          assert.equal(fac.settled.length, 1);
          assert.ok(same(fac.settled[0].payTo, PAY_TO));
          assert.equal(fac.settled[0].amount, '1000');
        });

        const deny = await runCli(['--network', 'testnet', '--rpc-url', cliEnv.RADIUS_RPC_URL, '--json', 'wallet', 'pay', 'get', url, '--threshold', '0.0001', '-y'], cliEnv);
        await t.check(`${at} CLI over threshold refuses without paying`, () => {
          assert.equal(deny.code, 2, deny.stderr);
          assert.equal(fac.settled.length, 1);
        });

        // A man in the middle rewrites the 402 recipient: the buyer signs to the attacker, the seller must refuse it.
        const rewritten = async (input, init) => {
          const response = await fetch(new Request(input, init));
          if (response.status !== 402) return response;
          const challenge = challengeOf(response);
          challenge.accepts = challenge.accepts.map((offer) => ({ ...offer, payTo: ATTACKER }));
          const headers = new Headers(response.headers);
          headers.set('payment-required', b64(challenge));
          return new Response(await response.text(), { status: 402, headers });
        };
        const misdirected = await buyer({ fetch: rewritten })(url).then(read, (error) => ({ error }));
        await t.check(`${at} payment signed to another recipient is refused`, () => {
          if (misdirected.error) assert.equal(misdirected.error.code, 'payment_rejected');
          else assert.doesNotMatch(misdirected.text, /quarterly-sales/);
          assert.equal(fac.settled.length, 1);
        });

        const replay = await read(await submit(url, happy.sent[0]));
        await t.check(`${at} replayed payment is refused`, () => {
          assert.notEqual(replay.status, 200);
          assert.doesNotMatch(replay.text, /quarterly-sales/);
          assert.equal(fac.settled.length, 1);
        });

        // The check the sell-api skill tells integrators to run before deploying, without paying.
        const sellCheck = await runCli(['--json', 'sell', 'check', url, '--price', '$0.001', '--facilitator', fac.url], cliEnv);
        let checked;
        try { checked = JSON.parse(sellCheck.stdout); } catch { checked = undefined; }
        t.observe(`${framework}.sellCheck`, checked ? { ok: checked.ok, summary: checked.summary, notPassed: checked.checks.filter((c) => c.status !== 'pass') } : { code: sellCheck.code, stderr: sellCheck.stderr.slice(-500) });
        await t.check(`${at} radius-cli sell check passes`, () => {
          assert.equal(sellCheck.code, 0, sellCheck.stderr || JSON.stringify(checked?.checks.filter((c) => c.status === 'fail')));
          assert.equal(checked.ok, true);
          assert.equal(fac.settled.length, 1);
        });
        t.observe(`${framework}.appOutputTail`, app.output().slice(-500));
      }
    });

    await execute('SELL-CHALLENGE', async (t) => {
      for (const kind of ADAPTERS) {
        const at = `[${kind}]`;
        const fac = await radiusFacilitator(t);
        const seller = await t.seller(kind, {
          options: { network: 'testnet', facilitator: { url: fac.url }, mpp: { secretKey: SECRET_KEY } },
          routes: { ...REPORT_ROUTE, 'GET /api/brief': { price: { amount: '42' }, maxTimeoutSeconds: 120 } },
          handlers: { ...REPORT_HANDLERS, 'GET /api/brief': content('brief') },
        });

        const free = await fetch(`${seller.url}/health`);
        await t.check(`${at} free route needs no payment`, () => assert.equal(free.status, 200));

        const issuedAt = Date.now();
        const res = await read(await fetch(`${seller.url}/api/report?q=1`));
        await t.check(`${at} 402 withholds content and is not cacheable`, () => {
          assert.equal(res.status, 402);
          assert.doesNotMatch(res.text, /CONTENT:/);
          assert.equal(seller.hitsOf('GET /api/report'), 0);
          assert.match(res.headers.get('cache-control') ?? '', /no-store/);
        });
        const challenge = challengeOf(res);
        await t.check(`${at} x402 offer`, () => {
          assert.equal(challenge.x402Version, 2);
          assert.equal(challenge.accepts.length, 1);
          const [offer] = challenge.accepts;
          assert.equal(offer.scheme, 'exact');
          assert.equal(offer.network, TESTNET.network);
          assert.ok(same(offer.asset, TESTNET.asset.address));
          assert.ok(same(offer.payTo, PAY_TO));
          assert.equal(offer.amount, '1000'); // $0.001 at SBC's 6 decimals
          assert.equal(offer.maxTimeoutSeconds, 300);
          assert.equal(offer.extra.assetTransferMethod, 'eip3009');
          assert.equal(offer.extra.name, TESTNET.asset.name);
          assert.equal(offer.extra.version, TESTNET.asset.version);
        });
        await t.check(`${at} resource is bound to the requested route`, () => {
          assert.equal(challenge.resource.url, `${seller.url}/api/report?q=1`);
          assert.equal(challenge.resource.description, 'Quarterly report');
          assert.equal(challenge.resource.mimeType, 'application/json');
        });

        const brief = await fetch(`${seller.url}/api/brief`);
        const briefChallenge = challengeOf(brief);
        await t.check(`${at} atomic price and maxTimeoutSeconds`, () => {
          assert.equal(briefChallenge.accepts[0].amount, '42');
          assert.equal(briefChallenge.accepts[0].maxTimeoutSeconds, 120);
          assert.equal(briefChallenge.resource.url, `${seller.url}/api/brief`);
        });

        const mpp = parseMppChallenges(res.headers.get('www-authenticate'));
        if (MPP_ADAPTERS.includes(kind)) {
          await t.check(`${at} MPP challenge mirrors the x402 offer`, () => {
            assert.equal(mpp.length, 1);
            const [c] = mpp;
            assert.deepEqual([c.method, c.intent, c.realm], ['evm', 'charge', new URL(seller.url).host]);
            assert.equal(c.request.amount, '1000');
            assert.ok(same(c.request.currency, TESTNET.asset.address));
            assert.ok(same(c.request.recipient, PAY_TO));
            assert.equal(c.request.methodDetails.chainId, TESTNET.chainId);
            assert.equal(c.request.methodDetails.decimals, 6);
            const expires = Date.parse(c.expires) - issuedAt;
            assert.ok(expires > 290_000 && expires < 310_000, `expires in ${expires}ms`);
          });
          const briefMpp = parseMppChallenges(brief.headers.get('www-authenticate'));
          await t.check(`${at} MPP challenge expiry follows maxTimeoutSeconds`, () => {
            const expires = Date.parse(briefMpp[0]?.expires) - Date.now();
            assert.ok(expires > 110_000 && expires <= 120_000, `expires in ${expires}ms`);
          });
        } else {
          // Known gap: `mpp` is accepted by createRadiusServer but only radiusPayments()/Hono serve it.
          // The upstream adapters (@x402/express, @x402/next) see x402 only. This asserts today's behavior.
          await t.check(`${at} upstream adapter emits no MPP challenge (known gap)`, () => {
            assert.equal(res.headers.get('www-authenticate'), null);
          });
        }

        // An asset with 18 decimals: the USD price is converted with the asset's decimals.
        const wide = await t.seller(kind, {
          options: { network: 'testnet', asset: { decimals: 18 }, facilitator: { url: fac.url }, mpp: { secretKey: SECRET_KEY } },
          routes: REPORT_ROUTE, handlers: REPORT_HANDLERS,
        });
        const wideRes = await fetch(`${wide.url}/api/report`);
        await t.check(`${at} USD price uses the asset's decimals`, () => {
          assert.equal(challengeOf(wideRes).accepts[0].amount, '1000000000000000');
          if (MPP_ADAPTERS.includes(kind)) assert.equal(parseMppChallenges(wideRes.headers.get('www-authenticate'))[0]?.request.methodDetails.decimals, 18);
        });
      }
    });

    await execute('SELL-DUAL', async (t) => {
      for (const kind of MPP_ADAPTERS) {
        const at = `[${kind}]`;
        const fac = await radiusFacilitator(t);
        const spec = (secretKey) => ({
          options: { network: 'testnet', facilitator: { url: fac.url }, mpp: { secretKey, realm: REALM } },
          routes: { ...REPORT_ROUTE, 'GET /api/brief': { price: '$0.001', maxTimeoutSeconds: 1 } },
          handlers: { ...REPORT_HANDLERS, 'GET /api/brief': content('brief') },
        });
        const seller = await t.seller(kind, spec(SECRET_KEY));
        const url = `${seller.url}/api/report`;

        const x402 = recorder();
        const viaX402 = await read(await buyer({ protocols: ['x402'], fetch: x402.fetch })(url));
        await t.check(`${at} x402 payment on a dual route settles once`, () => {
          assert.equal(viaX402.status, 200);
          assert.match(viaX402.text, /CONTENT:report/);
          assert.ok(viaX402.headers.get('payment-response'));
          assert.ok(!/^payment\s/i.test(x402.sent[0]), 'paid with PAYMENT-SIGNATURE');
          assert.equal(fac.settled.length, 1);
        });

        const mpp = recorder();
        const viaMpp = await read(await buyer({ protocols: ['mpp'], fetch: mpp.fetch })(url));
        await t.check(`${at} MPP payment on a dual route settles once`, () => {
          assert.equal(viaMpp.status, 200);
          assert.match(viaMpp.text, /CONTENT:report/);
          assert.match(mpp.sent[0], /^Payment /);
          assert.equal(fac.settled.length, 2);
          assert.equal(parseMppReceipt(viaMpp.headers.get('payment-receipt')).reference, fac.settled[1].transaction);
          assert.equal(seller.hitsOf('GET /api/report'), 2);
        });

        const rejected = async (label, response, reason) => {
          const r = await read(response);
          await t.check(`${at} ${label}`, () => {
            assert.equal(r.status, 402);
            assert.doesNotMatch(r.text, /CONTENT:/);
            assert.match(JSON.parse(r.text).detail, reason);
          });
        };
        const credential = await heldPayment(url, { protocols: ['mpp'] });
        const { challenge, payload, source } = parseMppCredential(credential);
        const tamper = (change) => {
          const c = { ...challenge, ...change };
          c.requestEncoded = encodeRequest(c.request);
          return serializeMppCredential(c, payload, source);
        };
        await rejected('tampered challenge amount is refused', await submit(url, tamper({ request: { ...challenge.request, amount: '1' } })), /not issued by this server/);
        await rejected('tampered challenge expiry is refused', await submit(url, tamper({ expires: new Date(Date.now() + 3_600_000).toISOString() })), /not issued by this server/);
        const other = await t.seller(kind, spec(OTHER_SECRET_KEY));
        await rejected('challenge issued under another secretKey is refused', await submit(`${other.url}/api/report`, credential), /not issued by this server/);
        const control = await read(await submit(url, credential));
        await t.check(`${at} the untampered credential is valid at its issuer (control)`, () => {
          assert.equal(control.status, 200);
          assert.equal(fac.settled.length, 3);
        });

        const brief = `${seller.url}/api/brief`;
        const short = await heldPayment(brief, { protocols: ['mpp'] });
        await sleep(1_500);
        await rejected('expired challenge is refused', await submit(brief, short), /expired/);
        await t.check(`${at} rejected credentials never settle or run the handler`, () => {
          assert.equal(fac.settled.length, 3);
          assert.equal(seller.hitsOf('GET /api/brief'), 0);
          assert.equal(other.hitsOf('GET /api/report'), 0);
        });
      }
    });

    await execute('SELL-MULTI-NET', async (t) => {
      for (const kind of ADAPTERS) {
        const at = `[${kind}]`;
        const radius = await radiusFacilitator(t);
        const base = await t.facilitator({ name: 'base-sepolia', networks: [BASE_KIND] });
        const seller = await t.seller(kind, {
          options: { networks: [{ network: 'testnet', facilitator: { url: radius.url } }, { network: 'base-sepolia', facilitator: { url: base.url } }] },
          routes: REPORT_ROUTE, handlers: REPORT_HANDLERS,
        });
        const url = `${seller.url}/api/report`;
        const offers = challengeOf(await fetch(url)).accepts;
        await t.check(`${at} one offer per network, in order`, () => {
          assert.deepEqual(offers.map((o) => o.network), [TESTNET.network, BASE_SEPOLIA.network]);
          assert.ok(same(offers[0].asset, TESTNET.asset.address));
          assert.ok(same(offers[1].asset, BASE_SEPOLIA.asset.address));
          assert.deepEqual(offers.map((o) => o.amount), ['1000', '1000']);
          assert.ok(offers.every((o) => same(o.payTo, PAY_TO)));
        });

        const onRadius = await buyer({ network: 'testnet' })(url);
        await t.check(`${at} Radius payment settles through the Radius facilitator only`, async () => {
          assert.equal(onRadius.status, 200);
          assert.equal(getPaymentReceipt(onRadius)?.network, TESTNET.network);
          assert.deepEqual([radius.settled.length, base.calls.settle], [1, 0]);
        });
        const onBase = await buyer({ network: 'base-sepolia' })(url);
        await t.check(`${at} Base Sepolia payment settles through its own facilitator only`, () => {
          assert.equal(onBase.status, 200);
          assert.equal(getPaymentReceipt(onBase)?.network, BASE_SEPOLIA.network);
          assert.deepEqual([radius.calls.settle, base.settled.length], [1, 1]);
        });

        // Relabel a payment signed for one offer as the other offer.
        for (const [from, to] of [['testnet', 1], ['base-sepolia', 0]]) {
          const signed = fromB64(await heldPayment(url, { network: from }));
          const crossed = await read(await submit(url, b64({ ...signed, accepted: offers[to] })));
          await t.check(`${at} payload signed for ${from} is refused against the ${offers[to].network} offer`, () => {
            assert.equal(crossed.status, 402);
            assert.doesNotMatch(crossed.text, /CONTENT:/);
          });
        }
        await t.check(`${at} cross-network attempts move nothing`, () => {
          assert.deepEqual([radius.settled.length, base.settled.length], [1, 1]);
          assert.equal(seller.hitsOf('GET /api/report'), 2);
        });
      }
    });

    await execute('SELL-FACILITATOR', async (t) => {
      for (const kind of ADAPTERS) {
        const at = `[${kind}]`;
        const url = (s) => `${s.url}/api/report`;
        const mpp = MPP_ADAPTERS.includes(kind) ? { secretKey: SECRET_KEY } : undefined;
        const sellerWith = (facilitator, extra = {}) => t.seller(kind, {
          options: { network: 'testnet', facilitator, mpp, ...extra }, routes: REPORT_ROUTE, handlers: REPORT_HANDLERS,
        });

        // /supported ordering decides the advertised transfer method.
        const eip3009First = await radiusFacilitator(t);
        const s1 = await sellerWith({ url: eip3009First.url });
        const r1 = await fetch(url(s1));
        await t.check(`${at} eip3009-first facilitator: EIP-3009 offer, no gas-sponsoring declaration`, () => {
          assert.equal(challengeOf(r1).accepts[0].extra.assetTransferMethod, 'eip3009');
          // EIP-3009 needs no approval, so there is nothing to sponsor even though the facilitator lists it.
          assert.ok(!('eip2612GasSponsoring' in (challengeOf(r1).extensions ?? {})), 'no sponsoring on an EIP-3009 offer');
          if (mpp) assert.equal(parseMppChallenges(r1.headers.get('www-authenticate')).length, 1);
        });
        const permit2First = await t.facilitator({ name: 'permit2-first', networks: [{ ...RADIUS_KIND, methods: ['permit2', 'eip3009'] }] });
        const s2 = await sellerWith({ url: permit2First.url });
        const r2 = await fetch(url(s2));
        await t.check(`${at} permit2-first facilitator: Permit2 offer, no sponsoring, no MPP`, () => {
          assert.equal(challengeOf(r2).accepts[0].extra.assetTransferMethod, 'permit2');
          assert.ok(!('eip2612GasSponsoring' in (challengeOf(r2).extensions ?? {})), 'unsupported sponsoring is stripped');
          // MPP's evm charge is EIP-3009 only, so a Permit2-only offer has no MPP mirror.
          assert.equal(r2.headers.get('www-authenticate'), null);
        });
        const sponsoredPermit2 = await t.facilitator({ name: 'permit2-first-sponsored', networks: [{ ...RADIUS_KIND, methods: ['permit2', 'eip3009'] }], extensions: ['eip2612GasSponsoring'] });
        const s2s = await sellerWith({ url: sponsoredPermit2.url });
        const r2s = await fetch(url(s2s));
        await t.check(`${at} permit2-first facilitator with sponsoring: Permit2 offer, gas sponsoring declared`, () => {
          assert.equal(challengeOf(r2s).accepts[0].extra.assetTransferMethod, 'permit2');
          assert.ok('eip2612GasSponsoring' in (challengeOf(r2s).extensions ?? {}));
        });
        const viaPermit2 = await buyer()(url(s2));
        await t.check(`${at} Permit2 payment settles`, () => {
          assert.equal(viaPermit2.status, 200);
          assert.deepEqual(permit2First.settled.map((s) => s.method), ['permit2']);
        });

        // A custom FacilitatorClient (in-process, same checks) instead of a URL.
        const custom = await radiusFacilitator(t);
        const s3 = await sellerWith(custom.client);
        const viaCustom = await buyer()(url(s3));
        await t.check(`${at} custom FacilitatorClient verifies and settles`, () => {
          assert.equal(viaCustom.status, 200);
          assert.equal(custom.settled.length, 1);
          assert.equal(custom.calls.supported, 1);
        });

        // Failure modes, per settle order: rejection is a 402, an unknown outcome is a 502, and content is withheld.
        for (const settle of ['before', 'after']) {
          const fac = await radiusFacilitator(t);
          const seller = await sellerWith({ url: fac.url, timeoutMs: 500 }, { settle });
          const hits = () => seller.hitsOf('GET /api/report');
          const attempt = () => buyer()(url(seller)).then(read, (error) => ({ error }));
          const ran = settle === 'after' ? 1 : 0; // 'after' runs the handler before settling, then withholds its body

          fac.reset({ settle: 'reject' });
          const rejection = await attempt();
          const rejected = rejection.error?.details?.response ? await read(rejection.error.details.response) : undefined;
          await t.check(`${at}/${settle} facilitator rejection: 402, payment_rejected, nothing delivered`, () => {
            assert.equal(rejection.error?.code, 'payment_rejected');
            assert.equal(fac.settled.length, 0);
            assert.equal(hits(), ran);
          });
          await t.check(`${at}/${settle} rejected response withholds the body`, () => assert.doesNotMatch(rejected.text, /CONTENT:/));

          fac.reset({ settle: 'hang' });
          const timeout = await attempt();
          await t.check(`${at}/${settle} facilitator timeout: 502 (unknown outcome), content withheld`, () => {
            assert.equal(timeout.status, 502);
            assert.doesNotMatch(timeout.text, /CONTENT:/);
            assert.equal(hits(), 2 * ran);
          });

          fac.reset({ settle: 'drop-after-submit' });
          const dropped = await attempt();
          await t.check(`${at}/${settle} connection dropped after settlement: 502, content withheld, funds moved`, () => {
            assert.equal(dropped.status, 502);
            assert.doesNotMatch(dropped.text, /CONTENT:/);
            assert.equal(fac.settled.length, 1, 'the mock chain recorded the settlement the seller never confirmed');
            assert.equal(hits(), 3 * ran);
          });
          // 'after' ran the handler before settlement failed: its headers must be withheld along with its body.
          const noHeaders = () => assert.deepEqual([rejected, timeout, dropped].map(headerLeaks), [false, false, false]);
          const headerGap = settle === 'after' && {
            hono: "radius-sdk/hono assigns c.res and Hono's setter merges the handler response's headers into the SDK's failure response",
            express: '@x402/express drops the buffered body on a failed settlement but keeps headers the handler already set',
          }[kind];
          if (headerGap) await t.known(`${at}/${settle} failed settlement withholds the handler's headers`, headerGap, noHeaders);
          else await t.check(`${at}/${settle} failed settlement withholds the handler's headers`, noHeaders);
          await t.check(`${at}/${settle} rejection and unknown outcome are distinguishable`, () => {
            assert.ok(rejection.error instanceof RadiusPaymentError && !timeout.error && !dropped.error);
          });

          if (settle === 'after') {
            fac.reset({ verify: 'reject' });
            const unverified = await attempt();
            await t.check(`${at}/after verify rejection: handler never runs, no settle`, () => {
              assert.equal(unverified.error?.code, 'payment_rejected');
              assert.equal(fac.calls.settle, 0);
              assert.equal(hits(), 3);
            });
          }
        }
      }
    });

    await execute('SELL-REPLAY', async (t) => {
      for (const kind of ADAPTERS) {
        for (const settle of ['before', 'after']) {
          const at = `[${kind}/${settle}]`;
          const fac = await radiusFacilitator(t);
          const seller = await t.seller(kind, {
            options: { network: 'testnet', settle, facilitator: { url: fac.url }, mpp: { secretKey: SECRET_KEY } },
            routes: REPORT_ROUTE, handlers: REPORT_HANDLERS,
          });
          const url = `${seller.url}/api/report`;
          const hits = () => seller.hitsOf('GET /api/report');
          const served = (responses) => responses.filter((r) => r.status === 200 && r.text.includes('CONTENT:report')).length;

          const first = recorder();
          const paid = await read(await buyer({ fetch: first.fetch })(url));
          const replay = await read(await submit(url, first.sent[0]));
          await t.check(`${at} sequential replay serves once`, () => {
            assert.equal(served([paid, replay]), 1);
            assert.equal(fac.settled.length, 1);
            assert.equal(hits(), 1);
          });

          const header = await heldPayment(url);
          const before = hits();
          const racing = await Promise.all([submit(url, header), submit(url, header)].map((p) => p.then(read)));
          t.observe(`${kind}.${settle}.concurrent`, { statuses: racing.map((r) => r.status), handlerRuns: hits() - before });
          await t.check(`${at} concurrent replay serves once and settles once`, () => {
            assert.equal(served(racing), 1);
            assert.equal(fac.settled.length, 2);
            // 'before' settles first, so only the winner reaches the handler. 'after' verifies both, runs the
            // handler for both, and the loser's settle fails: its body is withheld (recorded in observations).
            assert.equal(hits() - before, settle === 'before' ? 1 : 2);
          });

          if (MPP_ADAPTERS.includes(kind)) {
            const mpp = recorder();
            const viaMpp = await read(await buyer({ protocols: ['mpp'], fetch: mpp.fetch })(url));
            const mppReplay = await read(await submit(url, mpp.sent[0]));
            await t.check(`${at} MPP credential replay serves once`, () => {
              assert.equal(served([viaMpp, mppReplay]), 1);
              assert.equal(fac.settled.length, 3);
            });
          }
        }
      }
    });

    await execute('SELL-ORDER', async (t) => {
      const handlers = {
        'GET /api/ok': content('ok'),
        'GET /api/missing': () => ({ status: 404, json: { error: 'no such record' } }),
        'GET /api/broken': () => ({ status: 500, json: { error: 'upstream failed' } }),
        'GET /api/throws': () => { throw new Error('handler crashed'); },
      };
      const routes = Object.fromEntries(Object.keys(handlers).map((key) => [key, '$0.001']));
      for (const kind of ADAPTERS) {
        for (const settle of ['before', 'after']) {
          const at = `[${kind}/${settle}]`;
          const fac = await radiusFacilitator(t);
          const seller = await t.seller(kind, { options: { network: 'testnet', settle, facilitator: { url: fac.url } }, routes, handlers });
          const outcome = {};
          for (const key of Object.keys(handlers)) {
            const path = key.split(' ')[1];
            const settledBefore = fac.settled.length;
            const res = await buyer()(`${seller.url}${path}`);
            outcome[path] = { status: res.status, settled: fac.settled.length > settledBefore, receipt: getPaymentReceipt(res)?.success ?? false, handlerRuns: seller.hitsOf(key) };
            await res.arrayBuffer();
          }
          t.observe(`${kind}.${settle}`, outcome);
          await t.check(`${at} paid 200 settles and delivers`, () => {
            assert.deepEqual(outcome['/api/ok'], { status: 200, settled: true, receipt: true, handlerRuns: 1 });
          });
          await t.check(`${at} every failing handler ran once and failed delivery`, () => {
            assert.deepEqual(['/api/missing', '/api/broken', '/api/throws'].map((p) => [outcome[p].handlerRuns, outcome[p].status >= 400]), [[1, true], [1, true], [1, true]]);
            assert.equal(outcome['/api/missing'].status, 404);
          });
          if (settle === 'after') {
            await t.check(`${at} settles only when the handler answered < 400`, () => {
              assert.equal(fac.calls.settle, 1);
              assert.deepEqual(['/api/missing', '/api/broken', '/api/throws'].map((p) => outcome[p].settled), [false, false, false]);
            });
          } else {
            // SELL-01: money moved before delivery failed. The seller's response must carry the receipt so the
            // buyer can reconcile the paid failure instead of paying again.
            await t.check(`${at} settled before the handler; failures are paid and carry the receipt`, () => {
              assert.deepEqual(['/api/missing', '/api/broken', '/api/throws'].map((p) => outcome[p].settled), [true, true, true]);
              assert.deepEqual(['/api/missing', '/api/broken'].map((p) => outcome[p].receipt), [true, true]);
            });
            await t.check(`${at} a thrown handler error still returns the receipt`, () => assert.equal(outcome['/api/throws'].receipt, true));
          }
        }
      }
    });

    await execute('SELL-ROUTING', async (t) => {
      const creators = { alice: ALICE, bob: BOB };
      const goldTier = (url) => url.searchParams.getAll('tier').includes('gold');
      const handlers = {
        'GET /api/premium/:id': content('premium'),
        'GET /api/:id': content('basic'),
        'GET /creators/:creator/feed': ({ params }) => ({ json: { content: `CONTENT:feed:${params.creator}` } }),
        'GET /reports': ({ url }) => ({ json: { content: `CONTENT:${goldTier(url) ? 'gold' : 'basic'}-report` } }),
        'GET /cached': () => ({ json: { content: 'CONTENT:cached' }, headers: { 'cache-control': 'public, max-age=60' } }),
      };
      const routes = (urlOf) => ({
        'GET /api/premium/*': { price: { amount: '5000' } },
        'GET /api/*': { price: { amount: '1000' } },
        'GET /creators/:creator/feed': { price: '$0.001', payTo: (ctx) => creators[urlOf(ctx).pathname.split('/')[2]] ?? PAY_TO },
        'GET /reports': { price: (ctx) => ({ amount: goldTier(urlOf(ctx)) ? '9000' : '1000' }) },
        'GET /cached': '$0.001',
      });
      for (const kind of ADAPTERS) {
        const at = `[${kind}]`;
        const fac = await radiusFacilitator(t);
        const seller = await t.seller(kind, { options: { network: 'testnet', facilitator: { url: fac.url } }, routes, handlers });
        const offer = async (path) => challengeOf(await fetch(`${seller.url}${path}`)).accepts[0];
        const refusedAt = async (label, path, header, marker) => {
          const r = await read(await submit(`${seller.url}${path}`, header));
          await t.check(`${at} ${label}`, () => {
            assert.equal(r.status, 402);
            assert.ok(!r.text.includes(marker), 'protected content leaked');
          });
        };

        // Dynamic payTo: the challenge names each creator, and a payment to one cannot unlock another.
        await t.check(`${at} dynamic payTo binds the recipient to the route`, async () => {
          assert.ok(same((await offer('/creators/alice/feed')).payTo, ALICE));
          assert.ok(same((await offer('/creators/bob/feed')).payTo, BOB));
        });
        const aliceFeed = await read(await buyer()(`${seller.url}/creators/alice/feed`));
        await t.check(`${at} paying alice delivers alice's feed to alice`, () => {
          assert.match(aliceFeed.text, /CONTENT:feed:alice/);
          assert.ok(same(fac.settled.at(-1).payTo, ALICE));
        });
        await refusedAt("payment to alice cannot unlock bob's feed", '/creators/bob/feed', await heldPayment(`${seller.url}/creators/alice/feed`), 'CONTENT:feed:bob');

        // Dynamic price from the query, including duplicate keys.
        await t.check(`${at} dynamic price follows the query, duplicates included`, async () => {
          assert.equal((await offer('/reports?tier=basic')).amount, '1000');
          assert.equal((await offer('/reports?tier=gold')).amount, '9000');
          const dup = challengeOf(await fetch(`${seller.url}/reports?tier=basic&tier=gold`));
          assert.equal(dup.accepts[0].amount, '9000');
          assert.equal(new URL(dup.resource.url).search, '?tier=basic&tier=gold');
        });
        await refusedAt('basic-tier payment cannot unlock a duplicate-key gold request', '/reports?tier=basic&tier=gold', await heldPayment(`${seller.url}/reports?tier=basic`), 'CONTENT:gold');

        // Overlapping routes: the more specific pattern is declared first and must price premium content.
        await t.check(`${at} overlapping routes price each resource`, async () => {
          assert.equal((await offer('/api/premium/x')).amount, '5000');
          assert.equal((await offer('/api/x')).amount, '1000');
        });
        await refusedAt('basic payment cannot unlock premium content', '/api/premium/x', await heldPayment(`${seller.url}/api/x`), 'CONTENT:premium');

        // Path spellings a router may send to the premium handler: each must be charged at the premium price or not served.
        const premiumHitsBefore = seller.hitsOf('GET /api/premium/:id');
        const spellings = {};
        for (const path of ['/API/premium/x', '/api/Premium/x', '/api/%70remium/x', '/api//premium/x', '/api/premium/x/', '/api/./premium/x', '/api/premium%2Fx', '/api/x/../premium/x']) {
          const r = await rawRequest(seller.url, path);
          const amount = r.status === 402 ? fromB64(r.headers.get('payment-required')).accepts[0].amount : undefined;
          spellings[path] = { status: r.status, amount };
          await t.check(`${at} ${path} is not served free`, () => assert.ok(!r.text.includes('CONTENT:'), `status ${r.status}`));
          if (amount !== undefined && amount !== '5000') {
            // Charged less than premium: paying it must not unlock premium content.
            const paid = await read(await buyer({ fetch: rawPathFetch(seller.url, path) })(`${seller.url}/raw-path`));
            spellings[path].paidStatus = paid.status;
            await t.check(`${at} ${path} charged ${amount} does not deliver premium`, () => assert.ok(!paid.text.includes('CONTENT:premium')));
          }
        }
        t.observe(`${kind}.pathSpellings`, spellings);
        await t.check(`${at} no unpaid request reached the premium handler`, () => assert.equal(seller.hitsOf('GET /api/premium/:id'), premiumHitsBefore));

        // Cached response: paid content must be marked private so a shared cache does not replay it.
        const cached = await buyer()(`${seller.url}/cached`);
        const cacheControl = cached.headers.get('cache-control');
        t.observe(`${kind}.paidCacheControl`, cacheControl);
        const isPrivate = () => {
          assert.equal(cached.status, 200);
          assert.match(cacheControl ?? '', /\bprivate\b/);
        };
        if (kind === 'hono') {
          // radius-sdk/hono assigns `c.res = <SDK response>`; Hono's setter copies the handler response's headers
          // back over it, so the handler's Cache-Control replaces the SDK's `private`.
          await t.known(`${at} paid response is private to the payer`, "Hono's c.res setter re-applies the handler's Cache-Control over the SDK's `private`", isPrivate);
        } else await t.check(`${at} paid response is private to the payer`, isPrivate);
        await t.check(`${at} a later unpaid request is charged again`, async () => assert.equal((await fetch(`${seller.url}/cached`)).status, 402));

        // Recorded, not graded: a payment carries the resource URL it was quoted for, but sellers match only the
        // offer (price, asset, recipient, network). The same offer on another URL of the route accepts it.
        const sameOffer = await read(await submit(`${seller.url}/api/y`, await heldPayment(`${seller.url}/api/x`)));
        t.observe(`${kind}.resourceUrlBinding`, sameOffer.status === 200 ? 'not enforced: payment quoted for /api/x unlocked /api/y at the same price' : `enforced (${sameOffer.status})`);
        // Routers answer HEAD with the GET handler (body stripped), but the x402 route key "GET /api/premium/*" does not
        // match HEAD, so the paid handler runs unpaid. No body is delivered; the handler's work and headers are.
        const head = await rawRequest(seller.url, '/api/premium/x', { method: 'HEAD' });
        const headRuns = seller.hitsOf('GET /api/premium/:id') - premiumHitsBefore;
        t.observe(`${kind}.unpaidHead`, { status: head.status, premiumHandlerRuns: headRuns });
        await t.known(`${at} unpaid HEAD does not run the paid GET handler`, 'x402 route verbs match exactly; HEAD bypasses a paid GET route', () => {
          assert.equal(head.status, 402);
          assert.equal(headRuns, 0);
        });
      }

      // Recorded, not graded: x402 core matches routes first-declared-first, so declaration order decides overlaps.
      const fac = await radiusFacilitator(t);
      const genericFirst = await t.seller('web', {
        options: { network: 'testnet', facilitator: { url: fac.url } },
        routes: { 'GET /api/*': { price: { amount: '1000' } }, 'GET /api/premium/*': { price: { amount: '5000' } } },
        handlers,
      });
      t.observe('genericRouteDeclaredFirst.premiumPrice', challengeOf(await fetch(`${genericFirst.url}/api/premium/x`)).accepts[0].amount);
    });

    // -- Publisher shapes: middleware in a real framework, a Worker in front of an origin, humans-free/agents-pay -----

    /** Provision `deps` and a scratch copy of a fixture; a part that cannot run here (offline) is a SKIP, not a failure. */
    const frameworkApp = async (t, label, { key, deps, fixture, files }) => {
      let provisioned;
      try {
        provisioned = await provision(key, deps);
      } catch (error) {
        if (!(error instanceof Unavailable)) throw error;
        t.skip(label, error.message);
        return undefined;
      }
      const app = await prepareApp({ provisioned, fixture: join(HERE, 'fixtures', fixture), sdkRoot: join(ROOT, 'packages/sdk'), files });
      t.defer(app.remove);
      return { ...app, provisioned };
    };
    const sellerEnv = (fac, extra = {}) => cleanEnv({ PAY_TO, RADIUS_FACILITATOR_URL: fac.url, MPP_SECRET_KEY: SECRET_KEY, ...extra });
    const httpUp = (url, path = '/') => async () => (await fetch(`${url}${path}`)).status === 200;
    const forwarded = { 'x-forwarded-host': PUBLIC_HOST, 'x-forwarded-proto': 'https' };
    const noContent = (r) => assert.doesNotMatch(r.text, /CONTENT:/);

    await execute('SELL-NEXT-MW', async (t) => {
      const fac = await radiusFacilitator(t);
      const app = await frameworkApp(t, `next@${NEXT_DEPS.next}`, { key: `next-${NEXT_DEPS.next}`, deps: NEXT_DEPS, fixture: 'sell-next' });
      if (!app) return;
      const env = sellerEnv(fac, { NEXT_TELEMETRY_DISABLED: '1' });
      const next = join(app.provisioned, 'node_modules/next/dist/bin/next');
      const build = await runAsync(process.execPath, [next, 'build'], { cwd: app.dir, env });
      await t.check('next build succeeds', () => assert.equal(build.code, 0, build.output.slice(-1500)));
      if (build.code !== 0) return;
      const manifest = JSON.parse(await readFile(join(app.dir, '.next/server/middleware-manifest.json'), 'utf8'));
      await t.check('middleware is built for the edge runtime', () => assert.ok(manifest.middleware['/'].files.some((f) => f.includes('edge-runtime-webpack'))));
      const buildId = (await readFile(join(app.dir, '.next/BUILD_ID'), 'utf8')).trim();

      const port = await freePort();
      const url = `http://127.0.0.1:${port}`;
      const server = await startProcess(process.execPath, [next, 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: app.dir, env, name: 'next start', ready: httpUp(url) });
      t.defer(server.stop);
      const get = (path, init) => fetch(`${url}${path}`, init).then(read);
      const dataUrl = `/_next/data/${buildId}/legacy/one.json`;
      // ISR (App Router, generateStaticParams), a fully static page, a dynamic page, and a Pages Router page and its JSON data URL.
      const pages = ['/articles/hello', '/static', '/dynamic', '/legacy/one', dataUrl];

      for (const path of pages) {
        const unpaid = await get(path);
        await t.check(`unpaid ${path} gets a 402 with no content, not cacheable`, () => {
          assert.equal(unpaid.status, 402);
          noContent(unpaid);
          assert.match(unpaid.headers.get('cache-control') ?? '', /no-store/);
        });
      }
      const offer = challengeOf(await fetch(`${url}/static`)).accepts[0];
      await t.check('the 402 offers the configured price on Radius testnet', () => {
        assert.deepEqual([offer.network, offer.amount, offer.payTo.toLowerCase()], [TESTNET.network, '1000', PAY_TO.toLowerCase()]);
      });
      await t.check('the 402 also carries an MPP challenge', async () => {
        assert.equal(parseMppChallenges((await fetch(`${url}/static`)).headers.get('www-authenticate')).length, 1);
      });
      await t.check('an unpaid RSC request (?_rsc=, RSC header) gets a 402', async () => {
        const rsc = await get('/articles/hello?_rsc=eval', { headers: { rsc: '1' } });
        assert.equal(rsc.status, 402);
        noContent(rsc);
      });
      for (const path of ['/articles/hello', '/static', '/dynamic', '/legacy/one']) {
        await t.check(`unpaid HEAD ${path} gets a 402 (HEAD is priced)`, async () => assert.equal((await fetch(`${url}${path}`, { method: 'HEAD' })).status, 402));
      }

      const human = await get('/articles/hello', { headers: { 'user-agent': BROWSER_UA } });
      t.observe('freePageCacheControl', human.headers.get('cache-control'));
      await t.check('a browser User-Agent reads the page free (no 402, nothing settled)', () => {
        assert.equal(human.status, 200);
        assert.match(human.text, /CONTENT:article/);
        assert.equal(human.headers.get('payment-required'), null);
        assert.equal(fac.settled.length, 0);
      });

      for (const path of pages) {
        const before = fac.settled.length;
        const res = await buyer()(`${url}${path}`);
        const paid = await read(res);
        await t.check(`x402 payment unlocks ${path}: 200, content, receipt, private, settled once`, () => {
          assert.equal(paid.status, 200);
          assert.match(paid.text, /CONTENT:/);
          assert.equal(getPaymentReceipt(res, TESTNET)?.success, true);
          assert.match(paid.headers.get('cache-control') ?? '', /\bprivate\b/);
          assert.equal(fac.settled.length, before + 1);
        });
      }
      const mppBefore = fac.settled.length;
      const viaMpp = await read(await buyer({ protocols: ['mpp'] })(`${url}/articles/world`));
      await t.check('MPP payment unlocks an ISR page and returns Payment-Receipt', () => {
        assert.equal(viaMpp.status, 200);
        assert.match(viaMpp.text, /CONTENT:article/);
        assert.ok(viaMpp.headers.get('payment-receipt'));
        assert.equal(fac.settled.length, mppBefore + 1);
      });
      await t.check('a paid request does not poison the ISR cache: the next unpaid request is charged', async () => assert.equal((await get('/articles/hello')).status, 402));

      // Paid 404: the middleware settles before Next renders, and NextResponse.next() is always 200 to the SDK.
      const missingSlug = await get('/articles/nope');
      const settledBeforeMissing = fac.settled.length;
      const missingPaid = await read(await buyer()(`${url}/articles/nope`));
      await t.check('mitigation: validated slugs only. An unknown slug is a free 404 with no payment challenge', () => {
        assert.equal(missingSlug.status, 404);
        assert.equal(missingSlug.headers.get('payment-required'), null);
        assert.equal(missingPaid.status, 404);
        assert.equal(fac.settled.length, settledBeforeMissing);
      });
      await t.check('without validation a missing page is still priced (402)', async () => assert.equal((await get('/naive/nope')).status, 402));
      const settledBeforeNaive = fac.settled.length;
      const naivePaid = await read(await buyer()(`${url}/naive/nope`));
      t.observe('naiveMissingPage', { status: naivePaid.status, settled: fac.settled.length - settledBeforeNaive });
      await t.known('a paid request for a missing page is not settled', 'middleware settles before Next renders; NextResponse.next() is always 200, so the 404 is invisible to the SDK',
        () => assert.equal(fac.settled.length, settledBeforeNaive));

      // `settle: 'after'` waits for the response, but NextResponse.next() is a 200 whatever page Next renders next.
      const settledBeforeLazy = fac.settled.length;
      const lazyPaid = await read(await buyer()(`${url}/lazy/nope`));
      t.observe('afterModeMissingPage', { status: lazyPaid.status, settled: fac.settled.length - settledBeforeLazy });
      await t.check("recorded: settle: 'after' in middleware still charges a missing page", () => {
        assert.equal(lazyPaid.status, 404);
        assert.equal(fac.settled.length, settledBeforeLazy + 1);
      });

      // resource.url: `next start` builds req.url from its own hostname.
      const rebuilt = challengeOf(await fetch(`${url}/articles/hello`, { headers: forwarded })).resource.url;
      await t.check('mitigation: rebuilding the request from x-forwarded-host/proto names the public URL in resource.url', () => assert.equal(rebuilt, `https://${PUBLIC_HOST}/articles/hello`));
      await t.check('mitigation: without forwarded headers resource.url is the requested URL', async () => {
        assert.equal(challengeOf(await fetch(`${url}/articles/hello`)).resource.url, `${url}/articles/hello`);
      });
      const naiveUrl = challengeOf(await fetch(`${url}/naive/hello`, { headers: forwarded })).resource.url;
      t.observe('naiveResourceUrl', naiveUrl);
      await t.known('pay(req) with the raw req.url: resource.url names the forwarded public host', 'next start builds req.url from its own hostname (localhost) and ignores Host and X-Forwarded-Host; only X-Forwarded-Proto is applied',
        () => assert.equal(naiveUrl, `https://${PUBLIC_HOST}/naive/hello`));

      const settledBeforeCheck = fac.settled.length;
      const sellCheck = await runCli(['--json', 'sell', 'check', `${url}/articles/hello`, '--price', '$0.001', '--facilitator', fac.url, '--probe-head'], cliEnv);
      let checked;
      try { checked = JSON.parse(sellCheck.stdout); } catch { checked = undefined; }
      t.observe('sellCheck', checked ? { ok: checked.ok, summary: checked.summary, notPassed: checked.checks.filter((c) => c.status !== 'pass') } : { code: sellCheck.code, stderr: sellCheck.stderr.slice(-500) });
      await t.check('radius-cli sell check passes against the middleware (nothing paid)', () => {
        assert.equal(sellCheck.code, 0, sellCheck.stderr || JSON.stringify(checked?.checks.filter((c) => c.status === 'fail')));
        assert.equal(fac.settled.length, settledBeforeCheck);
      });
    });

    await execute('SELL-ASTRO-MW', async (t) => {
      const fixtureDir = join(HERE, 'fixtures/sell-astro');
      for (const target of ASTRO_TARGETS) {
        const at = `[${target.name}]`;
        const fac = await radiusFacilitator(t);
        const label = `astro@${target.deps.astro}`;
        /** A scratch app with `variant` as src/middleware.js, built with the real `astro build`. */
        const build = async (variant, extraEnv = {}) => {
          const app = await frameworkApp(t, label, { key: `${target.name}-${target.deps.astro}`, deps: target.deps, fixture: 'sell-astro', files: { 'src/middleware.js': join(fixtureDir, 'variants', variant) } });
          if (!app) return undefined;
          const env = sellerEnv(fac, { ASTRO_TELEMETRY_DISABLED: '1', ...extraEnv });
          const result = await runAsync(process.execPath, [join(app.provisioned, 'node_modules/astro/astro.js'), 'build'], { cwd: app.dir, env });
          const html = await readFile(join(app.dir, 'dist/client/prerendered/index.html'), 'utf8').catch(() => '');
          return { app, env, result, html };
        };

        // An unguarded middleware also runs at build time, for the prerendered page.
        const bad = await build('middleware.unguarded.js');
        if (!bad) continue;
        await t.check(`${at} an unguarded middleware still lets the build finish`, () => assert.equal(bad.result.code, 0, bad.result.output.slice(-1500)));
        t.observe(`${target.name}.unguardedPrerenderedOutput`, bad.html.slice(0, 200));
        await t.known(`${at} prerendered output survives an unguarded middleware`, 'the build renders the page through the middleware, pay() answers that request with its 402, and Astro writes that body to dist/client/prerendered/index.html',
          () => assert.match(bad.html, /CONTENT:prerendered/));

        const guarded = (extraEnv) => build(target.guard, extraEnv);
        const runGuarded = async (extraEnv, check) => {
          const good = await guarded(extraEnv);
          if (!good) return;
          await t.check(`${at} guarded build succeeds and keeps the prerendered page intact`, () => {
            assert.equal(good.result.code, 0, good.result.output.slice(-1500));
            assert.match(good.html, /CONTENT:prerendered/);
          });
          if (good.result.code !== 0) return;
          const port = await freePort();
          const url = `http://127.0.0.1:${port}`;
          const server = await startProcess(process.execPath, ['dist/server/entry.mjs'], { cwd: good.app.dir, env: { ...good.env, HOST: '127.0.0.1', PORT: String(port) }, name: `astro ${target.name}`, ready: httpUp(url) });
          t.defer(server.stop);
          await check(url);
        };

        await runGuarded({}, async (url) => {
          const get = (path, init) => fetch(`${url}${path}`, init).then(read);
          const unpaid = await get('/articles/hello');
          await t.check(`${at} SSR page: unpaid gets a 402 with no content, not cacheable`, () => {
            assert.equal(unpaid.status, 402);
            noContent(unpaid);
            assert.match(unpaid.headers.get('cache-control') ?? '', /no-store/);
          });
          await t.check(`${at} SSR page: unpaid HEAD gets a 402`, async () => assert.equal((await fetch(`${url}/articles/hello`, { method: 'HEAD' })).status, 402));
          await t.check(`${at} the free home page needs no payment`, async () => assert.equal((await get('/')).status, 200));
          for (const protocols of [['x402'], ['mpp']]) {
            const before = fac.settled.length;
            const res = await buyer({ protocols })(`${url}/articles/hello`);
            const paid = await read(res);
            await t.check(`${at} SSR page: ${protocols[0]} payment settles once and delivers`, () => {
              assert.equal(paid.status, 200);
              assert.match(paid.text, /CONTENT:ssr:hello/);
              assert.match(paid.headers.get('cache-control') ?? '', /\bprivate\b/);
              assert.equal(fac.settled.length, before + 1);
              if (protocols[0] === 'x402') assert.equal(getPaymentReceipt(res, TESTNET)?.success, true);
              else assert.ok(paid.headers.get('payment-receipt'));
            });
          }

          // Prerendered pages are static files the adapter serves without running the request-time middleware.
          const stat = await get('/prerendered');
          t.observe(`${target.name}.prerenderedUnpaid`, { status: stat.status, cacheControl: stat.headers.get('cache-control') });
          await t.known(`${at} a prerendered page listed in the routes is gated`, 'prerendered pages are served as static files and the request-time middleware does not gate them', () => {
            assert.equal(stat.status, 402);
            noContent(stat);
          });

          const rebuilt = challengeOf(await fetch(`${url}/articles/hello`, { headers: forwarded })).resource.url;
          const plain = challengeOf(await fetch(`${url}/articles/hello`)).resource.url;
          t.observe(`${target.name}.resourceUrl`, { plain, forwarded: rebuilt });
          if (target.name === 'astro5') {
            await t.known(`${at} resource.url honours X-Forwarded-Host`, 'Astro 5 ignores Host and X-Forwarded-Host unless security.allowedDomains names the host: request.url says http://localhost', () => assert.equal(rebuilt, `https://${PUBLIC_HOST}/articles/hello`));
          } else {
            await t.check(`${at} resource.url honours X-Forwarded-Host and X-Forwarded-Proto`, () => {
              assert.equal(rebuilt, `https://${PUBLIC_HOST}/articles/hello`);
              assert.equal(plain, `${url}/articles/hello`);
            });
          }
        });

        if (target.name === 'astro5') {
          await runGuarded({ EVAL_ALLOWED_HOST: PUBLIC_HOST }, async (url) => {
            const rebuilt = challengeOf(await fetch(`${url}/articles/hello`, { headers: forwarded })).resource.url;
            await t.check(`${at} mitigation: security.allowedDomains makes resource.url honour X-Forwarded-Host`, () => assert.equal(rebuilt, `https://${PUBLIC_HOST}/articles/hello`));
          });
        }
      }
    });

    await execute('SELL-WORKER-PROXY', async (t) => {
      const wrangler = join(SDK_MODULES, 'wrangler/bin/wrangler.js');
      if (!(await readFile(wrangler).then(() => true, () => false))) { t.skip('wrangler', `${wrangler} is not installed (pnpm install)`); return; }
      const fac = await radiusFacilitator(t);
      const articles = new Set(['hello', 'world']);
      const origin = { hits: [], last: undefined };
      const originServer = await listen(createServer((req, res) => {
        origin.hits.push(req.url);
        origin.last = req.headers;
        const slug = req.url.split('?')[0].split('/')[2];
        if (req.url.startsWith('/articles/') && !articles.has(slug)) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('NOT FOUND'); return; }
        // What a CMS origin behind a CDN typically sends.
        res.writeHead(200, {
          'content-type': 'text/html', 'cache-control': 'public, s-maxage=600', 'cdn-cache-control': 'max-age=600', 'surrogate-control': 'max-age=600',
          'surrogate-key': 'article-hello', 'set-cookie': 'origin_session=abc; Path=/; HttpOnly',
        });
        res.end(`<html><body><article>CONTENT:origin ${req.url}</article></body></html>`);
      }));
      t.defer(originServer.close);

      const app = await prepareApp({ provisioned: tmpdir(), fixture: join(HERE, 'fixtures/sell-worker'), sdkRoot: join(ROOT, 'packages/sdk') });
      t.defer(app.remove);
      const state = await mkdtemp(join(tmpdir(), 'radius-sell-wrangler-'));
      t.defer(() => rm(state, { recursive: true, force: true }));
      const port = await freePort();
      const url = `http://127.0.0.1:${port}`;
      const vars = { ORIGIN: originServer.url, RADIUS_FACILITATOR_URL: fac.url, PAY_TO, MPP_SECRET_KEY: SECRET_KEY };
      const server = await startProcess(process.execPath, [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(await freePort()),
        ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], {
        cwd: app.dir, name: 'wrangler dev (workerd)', timeoutMs: 90_000,
        env: cleanEnv({ CI: '1', WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: state, WRANGLER_HOME: state, WRANGLER_LOG: 'error' }),
        ready: httpUp(url, '/about'),
      });
      t.defer(server.stop);
      const get = (path, init) => fetch(`${url}${path}`, init).then(read);
      const hitsFor = (prefix) => origin.hits.filter((h) => h.startsWith(prefix)).length;
      origin.hits.length = 0;

      await t.check('a path outside the routes is passed to the origin free', async () => {
        const about = await get('/about');
        assert.equal(about.status, 200);
        assert.match(about.text, /CONTENT:origin \/about/);
      });
      origin.hits.length = 0;
      const unpaid = await get('/articles/hello');
      await t.check('unpaid gets a 402 with no content, not cacheable, and the origin is not called', () => {
        assert.equal(unpaid.status, 402);
        noContent(unpaid);
        assert.match(unpaid.headers.get('cache-control') ?? '', /no-store/);
        assert.equal(origin.hits.length, 0);
      });
      await t.check('the 402 carries the x402 offer and an MPP challenge', () => {
        assert.equal(challengeOf(unpaid).accepts[0].amount, '1000');
        assert.equal(parseMppChallenges(unpaid.headers.get('www-authenticate')).length, 1);
        assert.equal(challengeOf(unpaid).resource.url, `${url}/articles/hello`);
      });
      await t.check('unpaid HEAD gets a 402 and the origin is not called', async () => {
        assert.equal((await fetch(`${url}/articles/hello`, { method: 'HEAD' })).status, 402);
        assert.equal(origin.hits.length, 0);
      });

      const rec = recorder();
      const res = await buyer({ fetch: rec.fetch })(`${url}/articles/hello`);
      const paid = await read(res);
      t.observe('paidResponseHeaders', Object.fromEntries(['cache-control', 'cdn-cache-control', 'surrogate-control', 'surrogate-key', 'set-cookie', 'payment-response'].map((h) => [h, paid.headers.get(h)])));
      await t.check('x402 payment: 200, the origin body, receipt, settled once', () => {
        assert.equal(paid.status, 200);
        assert.match(paid.text, /CONTENT:origin \/articles\/hello/);
        assert.equal(getPaymentReceipt(res, TESTNET)?.success, true);
        assert.equal(fac.settled.length, 1);
        assert.equal(hitsFor('/articles/hello'), 1);
      });
      await t.check('the payment credential is not forwarded to the origin', () => {
        assert.equal(origin.last['payment-signature'], undefined);
        assert.equal(origin.last.authorization, undefined);
      });
      await t.check('paid response is marked private', () => assert.match(paid.headers.get('cache-control') ?? '', /\bprivate\b/));
      // Recorded as observed: the SDK adds `private` to the origin's Cache-Control and passes every other header through.
      await t.check('origin Set-Cookie passes through to the payer unchanged (recorded behavior)', () => assert.match(paid.headers.get('set-cookie') ?? '', /origin_session=abc/));
      await t.known('paid response carries no CDN-cacheable headers from the origin', "the SDK appends `private` to Cache-Control but leaves the origin's Surrogate-Control, CDN-Cache-Control and Surrogate-Key; Fastly and Cloudflare honour those ahead of Cache-Control (from their documentation, not exercised here)", () => {
        assert.equal(paid.headers.get('surrogate-control'), null);
        assert.equal(paid.headers.get('cdn-cache-control'), null);
      });

      const viaMpp = await read(await buyer({ protocols: ['mpp'] })(`${url}/articles/world`));
      await t.check('MPP payment: 200, the origin body, Payment-Receipt, settled once more', () => {
        assert.equal(viaMpp.status, 200);
        assert.match(viaMpp.text, /CONTENT:origin \/articles\/world/);
        assert.ok(viaMpp.headers.get('payment-receipt'));
        assert.equal(fac.settled.length, 2);
      });

      // Mitigation: strip the origin's CDN caching directives from the paid response in the Worker.
      const safeRes = await buyer()(`${url}/safe/hello`);
      const safe = await read(safeRes);
      await t.check('mitigation: removing the CDN caching headers leaves a private, no-store paid response', () => {
        assert.equal(safe.status, 200);
        assert.match(safe.text, /CONTENT:origin \/articles\/hello/);
        assert.equal(getPaymentReceipt(safeRes, TESTNET)?.success, true);
        assert.deepEqual(['surrogate-control', 'cdn-cache-control', 'surrogate-key'].map((h) => safe.headers.get(h)), [null, null, null]);
        assert.equal(safe.headers.get('cache-control'), 'private, no-store');
        assert.equal(fac.settled.length, 3);
      });

      // Paid 404 from the origin: its status is visible here, so `settle: 'after'` can skip the charge.
      const before = fac.settled.length;
      const missing = await read(await buyer()(`${url}/articles/nope`));
      t.observe('missingPageSettleBefore', { status: missing.status, settled: fac.settled.length - before });
      await t.known('a paid request for a page the origin 404s is not settled (settle: before)', "the default `settle: 'before'` charges before the origin answers", () => assert.equal(fac.settled.length, before));
      const afterBefore = fac.settled.length;
      const missingAfter = await read(await buyer()(`${url}/after/nope`));
      await t.check("mitigation: settle: 'after' does not charge when the origin answers 404", () => {
        assert.equal(missingAfter.status, 404);
        assert.equal(fac.settled.length, afterBefore);
      });
      const okAfter = await read(await buyer()(`${url}/after/hello`));
      await t.check("settle: 'after' still charges when the origin answers 200", () => {
        assert.equal(okAfter.status, 200);
        assert.match(okAfter.text, /CONTENT:origin \/articles\/hello/);
        assert.equal(fac.settled.length, afterBefore + 1);
      });
    });

    await execute('SELL-SELECTIVE', async (t) => {
      const { createGate } = await import(pathToFileURL(join(HERE, 'fixtures/sell-selective/gate.mjs')).href);
      const fac = await radiusFacilitator(t);
      const pay = radiusPayments({
        network: 'testnet', payTo: PAY_TO, facilitator: { url: fac.url }, mpp: { secretKey: SECRET_KEY },
        routes: { 'GET /articles/*': '$0.001', 'HEAD /articles/*': '$0.001' },
      });
      let originRuns = 0;
      const SUBSCRIBER = 'sub_9f2c1e';
      const cookieOf = (request) => /(?:^|;\s*)session=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
      const gate = createGate({
        pay,
        isSubscriber: (request) => cookieOf(request) === SUBSCRIBER, // verified against the subscriber store, not merely present
        origin: () => {
          originRuns++;
          return new Response('<html><body><article>CONTENT:article</article></body></html>', { headers: { 'content-type': 'text/html', 'cache-control': 'public, s-maxage=60' } });
        },
      });
      const site = await serveFetch(gate);
      t.defer(site.close);
      const page = `${site.url}/articles/hello`;
      const asClient = (headers, method = 'GET') => fetch(page, { method, headers }).then(read);
      const settled = () => fac.settled.length;

      const human = await asClient({ 'user-agent': BROWSER_UA });
      t.observe('humanResponseCacheControl', human.headers.get('cache-control'));
      await t.check('a browser User-Agent reads the page free: 200, no challenge, facilitator untouched', () => {
        assert.equal(human.status, 200);
        assert.match(human.text, /CONTENT:article/);
        assert.equal(human.headers.get('payment-required'), null);
        assert.equal(human.headers.get('www-authenticate'), null);
        assert.deepEqual([fac.calls.supported, fac.calls.verify, fac.calls.settle], [0, 0, 0]);
      });
      await t.check('a browser HEAD is free too', async () => assert.equal((await asClient({ 'user-agent': BROWSER_UA }, 'HEAD')).status, 200));

      originRuns = 0;
      const agents = {
        'a vendor crawler UA (GPTBot)': { 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)' },
        'a retrieval agent UA (ChatGPT-User)': { 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot' },
        'a ClaudeBot UA': { 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
        'a script (no browser UA)': { 'user-agent': 'python-requests/2.32.0' },
        'a bare fetch (the default node User-Agent)': {},
        'a browser UA plus a Signature-Agent header (Web Bot Auth claim)': { 'user-agent': BROWSER_UA, 'signature-agent': '"https://agent.example"' },
      };
      for (const [label, headers] of Object.entries(agents)) {
        const r = await asClient(headers);
        await t.check(`${label} gets a 402 with no content`, () => {
          assert.equal(r.status, 402);
          noContent(r);
          assert.match(r.headers.get('cache-control') ?? '', /no-store/);
        });
      }
      await t.check('a bot HEAD gets a 402', async () => assert.equal((await asClient({ 'user-agent': 'GPTBot/1.1' }, 'HEAD')).status, 402));
      await t.check('no 402 request reached the origin', () => assert.equal(originRuns, 0));

      const rec = recorder();
      const botBuyer = buyer({ fetch: rec.fetch });
      const viaX402 = await botBuyer(page, { headers: { 'user-agent': 'GPTBot/1.1' } });
      const paid = await read(viaX402);
      await t.check('a bot pays with the SDK buyer: 200, content, receipt, settled once, origin runs once', () => {
        assert.equal(paid.status, 200);
        assert.match(paid.text, /CONTENT:article/);
        assert.equal(getPaymentReceipt(viaX402, TESTNET)?.success, true);
        assert.equal(settled(), 1);
        assert.equal(originRuns, 1);
      });
      const viaMpp = await read(await buyer({ protocols: ['mpp'] })(page, { headers: { 'user-agent': 'GPTBot/1.1' } }));
      await t.check('a bot pays over MPP too', () => {
        assert.equal(viaMpp.status, 200);
        assert.ok(viaMpp.headers.get('payment-receipt'));
        assert.equal(settled(), 2);
      });

      // A payment header is handled whatever the client claims to be.
      const held = await heldPayment(page);
      const humanWithPayment = await read(await submit(page, held, { headers: { 'user-agent': BROWSER_UA } }));
      await t.check('a payment header from a browser-looking client is still verified and settled', () => {
        assert.equal(humanWithPayment.status, 200);
        assert.ok(humanWithPayment.headers.get('payment-response'));
        assert.equal(settled(), 3);
      });

      // Documented limitation: a header check cannot tell an agent that claims to be a browser from a browser.
      const before = settled();
      const spoofed = await asClient({ 'user-agent': BROWSER_UA });
      t.observe('spoofedBrowserUa', { status: spoofed.status, charged: settled() - before, note: 'a client that sends a browser User-Agent is treated as a human; verify bots with Web Bot Auth or the CDN bot score instead' });
      await t.check('LIMITATION: an agent sending a browser User-Agent is served free (UA checks are spoofable)', () => {
        assert.equal(spoofed.status, 200);
        assert.match(spoofed.text, /CONTENT:article/);
        assert.equal(settled(), before);
      });

      // Subscribers read free even when they look like bots; the credential is verified, not just present.
      // The check the skill tells integrators to run, with a header: it can also prove that humans stay free.
      const sellCheckAs = async (userAgent) => {
        const out = await runCli(['--json', 'sell', 'check', page, '--price', '$0.001', '--facilitator', fac.url, '-H', `User-Agent: ${userAgent}`], cliEnv);
        let json;
        try { json = JSON.parse(out.stdout); } catch { json = undefined; }
        return { code: out.code, json };
      };
      const asBot = await sellCheckAs('GPTBot/1.1');
      await t.check('radius-cli sell check -H "User-Agent: GPTBot/1.1" passes against the gate (nothing paid)', () => {
        assert.equal(asBot.code, 0, JSON.stringify(asBot.json?.checks.filter((c) => c.status === 'fail')));
        assert.equal(settled(), before);
      });
      const asHuman = await sellCheckAs(BROWSER_UA);
      await t.check('radius-cli sell check with a browser User-Agent fails: that request is served without payment', () => {
        assert.notEqual(asHuman.code, 0);
        assert.ok(asHuman.json?.checks.some((c) => c.status === 'fail'));
      });

      const subscriber = await asClient({ 'user-agent': 'GPTBot/1.1', cookie: `session=${SUBSCRIBER}` });
      await t.check('a verified subscriber cookie bypasses the gate', () => {
        assert.equal(subscriber.status, 200);
        assert.match(subscriber.text, /CONTENT:article/);
        assert.equal(settled(), before);
      });
      const forged = await asClient({ 'user-agent': 'GPTBot/1.1', cookie: 'session=forged' });
      await t.check('a forged subscriber cookie does not', () => {
        assert.equal(forged.status, 402);
        noContent(forged);
      });
    });
  } finally {
    await rpc.close();
    await rm(home, { recursive: true, force: true });
  }

  const count = (status) => cases.filter((c) => c.status === status).length;
  const report = {
    suite: 'agent-payments-seller', scenarioVersion: 1,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    dirtyCheckout: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0,
    generatedAt: new Date().toISOString(), integrator: process.env.SELL_INTEGRATOR_CMD ? 'command' : 'reference',
    simulatedOnly: true, verifiedNetworkSettlement: false,
    total: cases.length, passed: count('pass'), expectedFailures: count('xfail'), skipped: count('skip'), failed: count('fail'),
    knownGaps: cases.flatMap((c) => c.xfails.map((x) => ({ id: c.id, ...x }))),
    skips: cases.flatMap((c) => c.skips.map((x) => ({ id: c.id, ...x }))),
    cases,
  };
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\n${report.passed}/${report.total} passed, ${report.expectedFailures} expected failure(s), ${report.skipped} skipped, ${report.failed} failed. Report: ${resolve(output)}\n`);
  if (report.failed) process.exitCode = 1;
}

run().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
