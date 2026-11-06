/**
 * RADIUS_WALLET=proxy: the account comes from a wallet proxy (the Worker API of
 * radius-workshop/wallet-proxy), here a local HTTP server backed by a private key, so every
 * signature the CLI gets can be checked against the real account. No keystore is read or created.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverAddress, sha256, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// config.ts reads RADIUS_HOME at import time, so point it at a scratch directory first.
process.env.RADIUS_HOME = mkdtempSync(join(tmpdir(), 'radius-cli-proxy-'));
const { resolveConfig } = await import('../src/lib/config.js');
const { assertKeystoreWallet, deferredAccount, getOwnAddress, requireAccount, resetProxySigner } = await import('../src/lib/account.js');
const { signJwt } = await import('../src/lib/jwt.js');
type ResolvedConfig = import('../src/types.js').ResolvedConfig;

const privateKey = generatePrivateKey();
const real = privateKeyToAccount(privateKey);
const ALIAS = 'agent0-main';
const TOKEN = 'proxy-token';

interface Seen {
  op: string;
  auth: string | undefined;
  body: Record<string, unknown> | undefined;
}

const seen: Seen[] = [];
let server: Server;
let url: string;

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    const m = /^\/v1\/wallets\/([^/]+)\/([^/]+)$/.exec(req.url ?? '');
    const op = m?.[2] ?? 'unknown';
    seen.push({ op, auth: req.headers.authorization, body });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    if (!m || m[1] !== ALIAS) return json(res, 404, { error: { code: 'WALLET_NOT_FOUND', message: `Unknown wallet alias: ${m?.[1]}` } });
    switch (op) {
      case 'address':
        return json(res, 200, { provider: 'privy', alias: ALIAS, address: real.address.toLowerCase() });
      case 'capabilities':
        return json(res, 200, { provider: 'privy', alias: ALIAS, capabilities: { signTypedData: true, signTransaction: true, hashSigning: true, exportPrivateKey: false } });
      case 'sign-message':
        return json(res, 200, { signature: await real.signMessage({ message: body!.message as string }) });
      case 'sign-typed-data':
        return json(res, 200, { signature: await real.signTypedData(body!.typedData as never) });
      case 'sign-transaction':
        if (typeof body!.hash === 'string') return json(res, 200, { signature: await real.sign({ hash: body!.hash as Hex }) });
        return json(res, 400, { error: { code: 'INVALID_REQUEST', message: 'transaction mode not stubbed' } });
      default:
        return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function proxyEnv(overrides: Record<string, string | undefined> = {}) {
  const env = { RADIUS_WALLET: 'proxy', RADIUS_WALLET_PROXY_URL: url, RADIUS_WALLET_ALIAS: ALIAS, RADIUS_WALLET_PROXY_TOKEN: TOKEN, ...overrides };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const cfgFor = (): ResolvedConfig => resolveConfig({ network: 'testnet' });

beforeEach(() => {
  seen.length = 0;
  resetProxySigner();
  proxyEnv();
});

describe('resolveConfig', () => {
  it('reads RADIUS_WALLET and defaults to the keystore', () => {
    expect(cfgFor().wallet).toBe('proxy');
    proxyEnv({ RADIUS_WALLET: undefined });
    expect(cfgFor().wallet).toBe('keystore');
    proxyEnv({ RADIUS_WALLET: 'ledger' });
    expect(() => cfgFor()).toThrow(/RADIUS_WALLET must be 'keystore' or 'proxy'/);
  });
});

describe('RADIUS_WALLET=proxy', () => {
  it('getOwnAddress asks the proxy once and checksums the answer; no keystore is created', async () => {
    const cfg = cfgFor();
    expect(await getOwnAddress(cfg, undefined)).toBe(real.address);
    expect(await getOwnAddress(cfg, undefined)).toBe(real.address);
    expect(seen.map((s) => s.op)).toEqual(['address']);
    expect(seen[0].auth).toBe(`Bearer ${TOKEN}`);
    const { existsSync } = await import('node:fs');
    expect(existsSync(cfg.keystorePath)).toBe(false);
  });

  it('requireAccount signs messages, typed data and JWT hashes through the proxy', async () => {
    const account = await requireAccount(cfgFor(), undefined);
    expect(account.type).toBe('local');
    expect(account.address).toBe(real.address);
    expect(await account.signMessage({ message: 'hi' })).toBe(await real.signMessage({ message: 'hi' }));
    const typed = {
      domain: { name: 'T', version: '1', chainId: 72344 },
      types: { M: [{ name: 'v', type: 'uint256' }] },
      primaryType: 'M',
      message: { v: 1n },
    } as const;
    expect(await account.signTypedData(typed)).toBe(await real.signTypedData(typed));
    // The proxy got the bigint as a decimal string, with EIP712Domain spelled out.
    const sent = seen.find((s) => s.op === 'sign-typed-data')!.body!.typedData as { message: { v: unknown }; types: Record<string, unknown> };
    expect(sent.message.v).toBe('1');
    expect(sent.types.EIP712Domain).toBeDefined();

    const token = await signJwt(account, { claims: { aud: 'svc' }, expiresIn: 60, now: 1_700_000_000 });
    const [h, p, s] = token.split('.');
    const hash = sha256(Buffer.from(`${h}.${p}`));
    const rs = Buffer.from(s, 'base64url');
    const recovered = await Promise.all([27, 28].map((v) => recoverAddress({ hash, signature: `0x${rs.toString('hex')}${v.toString(16)}` })));
    expect(recovered).toContain(real.address);
    expect(seen.find((s) => s.op === 'sign-transaction')!.body).toEqual({ hash });
  });

  it('deferredAccount knows the address up front and asks the proxy to sign only when used', async () => {
    const account = await deferredAccount(cfgFor(), undefined);
    expect(account.address).toBe(real.address);
    expect(seen.map((s) => s.op)).toEqual(['address']);
    expect(await account.signMessage({ message: 'later' })).toBe(await real.signMessage({ message: 'later' }));
    expect(seen.map((s) => s.op)).toEqual(['address', 'sign-message']);
  });

  it('--private-key still wins over the proxy', async () => {
    const other = generatePrivateKey();
    expect((await requireAccount(cfgFor(), other)).address).toBe(privateKeyToAccount(other).address);
    expect(await getOwnAddress(cfgFor(), other)).toBe(privateKeyToAccount(other).address);
    expect(seen).toHaveLength(0);
  });

  it('refuses keystore-only commands with a pointer back to the keystore', () => {
    const cfg = cfgFor();
    for (const what of ['wallet new', 'wallet import', 'wallet password', 'wallet export']) {
      expect(() => assertKeystoreWallet(cfg, what)).toThrow(new RegExp(`^${what} is not available with RADIUS_WALLET=proxy`));
    }
    proxyEnv({ RADIUS_WALLET: undefined });
    expect(() => assertKeystoreWallet(cfgFor(), 'wallet export')).not.toThrow();
  });

  it('reports a proxy that refuses or is misconfigured', async () => {
    proxyEnv({ RADIUS_WALLET_PROXY_TOKEN: 'wrong' });
    await expect(getOwnAddress(cfgFor(), undefined)).rejects.toMatchObject({ code: 'signer_unavailable', details: { status: 401, code: 'UNAUTHORIZED' } });
    resetProxySigner();
    proxyEnv({ RADIUS_WALLET_ALIAS: 'agent9-main' });
    await expect(requireAccount(cfgFor(), undefined)).rejects.toMatchObject({ code: 'signer_unavailable', details: { status: 404, code: 'WALLET_NOT_FOUND' } });
    resetProxySigner();
    proxyEnv({ RADIUS_WALLET_PROXY_URL: undefined });
    await expect(getOwnAddress(cfgFor(), undefined)).rejects.toThrow(/RADIUS_WALLET_PROXY_URL is required/);
  });
});
