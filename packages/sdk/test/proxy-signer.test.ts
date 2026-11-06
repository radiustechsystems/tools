/**
 * `proxySigner` against an in-process wallet proxy that mirrors the Worker API of
 * `radius-workshop/wallet-proxy` (address, capabilities, sign-typed-data, sign-message,
 * sign-transaction, bearer auth, `{ error: { code, message } }` answers), backed by a private key
 * so signatures are real. Nothing here touches the network: the proxy is the signer's `fetch`
 * option, the seller is the buyer's. The end-to-end cases pay the same EIP-3009 and Permit2
 * challenges as `client-parity.test.ts`, with the proxy as the signer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maxUint256, parseTransaction, recoverAddress, recoverMessageAddress, recoverTypedDataAddress, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createRadiusFetch, RadiusPaymentError, type PaymentOffer } from '../src/client/index.js';
import { proxySigner, proxySignerEnv, type ProxySignerErrorDetails } from '../src/signers/proxy.js';
import { PERMIT2_ADDRESS, X402_EXACT_PERMIT2_PROXY, resolveNetwork } from '../src/networks.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const KEY = privateKeyToAccount(PK);
const URL_ = 'https://wallet-proxy.test';
const ALIAS = 'agent0-main';
const TOKEN = 'secret-token';

interface ProxyCall {
  method: string;
  path: string;
  headers: Headers;
  body?: Record<string, unknown>;
}

interface FakeProxy {
  fetch: typeof fetch;
  calls: ProxyCall[];
  /** Capabilities the proxy reports (default: everything but export). */
  capabilities: Record<string, boolean>;
  /** Lower-case the address in `/address`, like a provider that does not checksum. */
  lowercase: boolean;
  /** Fail every request at the transport (fetch rejects). */
  offline: boolean;
}

/** The Worker's API, backed by `KEY`. Only `ALIAS` exists; `TOKEN` is required. */
function fakeProxy(overrides: Partial<Pick<FakeProxy, 'capabilities' | 'lowercase' | 'offline'>> = {}): FakeProxy {
  const calls: ProxyCall[] = [];
  const proxy: FakeProxy = {
    calls,
    capabilities: { address: true, signMessage: true, signTypedData: true, signTransaction: true, hashSigning: true, exportPrivateKey: false },
    lowercase: false,
    offline: false,
    ...overrides,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (proxy.offline) throw new TypeError('fetch failed');
      const req = new Request(input, init);
      const url = new URL(req.url);
      const text = await req.text();
      const call: ProxyCall = { method: req.method, path: url.pathname, headers: req.headers, body: text ? JSON.parse(text) : undefined };
      calls.push(call);
      const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return error(401, 'UNAUTHORIZED', 'Unauthorized');
      const m = /^\/v1\/wallets\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (!m) return error(404, 'NOT_FOUND', 'Not found');
      const [, alias, op] = m;
      if (decodeURIComponent(alias) !== ALIAS) return error(404, 'WALLET_NOT_FOUND', `Unknown wallet alias: ${alias}`);
      const body = call.body ?? {};
      switch (op) {
        case 'address':
          return Response.json({ provider: 'privy', alias, address: proxy.lowercase ? KEY.address.toLowerCase() : KEY.address });
        case 'capabilities':
          return Response.json({ provider: 'privy', alias, capabilities: proxy.capabilities });
        case 'sign-typed-data': {
          const td = body.typedData as { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> } | undefined;
          if (!td) return error(400, 'INVALID_REQUEST', 'sign-typed-data requires typedData.');
          // A provider signs what it receives: decimal strings where viem had bigints.
          const signature = await KEY.signTypedData(td as never);
          return Response.json({ provider: 'privy', alias, signature });
        }
        case 'sign-message': {
          if (typeof body.message !== 'string') return error(400, 'INVALID_REQUEST', 'sign-message requires a string message.');
          return Response.json({ provider: 'privy', alias, signature: await KEY.signMessage({ message: body.message }) });
        }
        case 'sign-transaction': {
          if (typeof body.hash === 'string') return Response.json({ provider: 'privy', alias, signature: await KEY.sign({ hash: body.hash as Hex }) });
          if (body.transaction && typeof body.transaction === 'object') {
            const t = body.transaction as Record<string, string>;
            const signedTransaction = await KEY.signTransaction({
              chainId: Number(t.chainId),
              nonce: Number(t.nonce),
              to: t.to as Address,
              value: BigInt(t.value ?? '0x0'),
              data: t.data as Hex | undefined,
              gas: BigInt(t.gas),
              gasPrice: BigInt(t.gasPrice),
              type: 'legacy',
            });
            return Response.json({ provider: 'privy', alias, signedTransaction });
          }
          return error(400, 'INVALID_REQUEST', 'sign-transaction requires either hash or transaction.');
        }
        default:
          return error(404, 'NOT_FOUND', 'Not found');
      }
    }) as typeof fetch,
  };
  return proxy;
}

const signer = (proxy: FakeProxy, extra: Partial<Parameters<typeof proxySigner>[0]> = {}) => proxySigner({ url: URL_, alias: ALIAS, token: TOKEN, fetch: proxy.fetch, ...extra });

const unavailable = (p: Promise<unknown>, match: Partial<ProxySignerErrorDetails> & { message?: RegExp }) =>
  expect(p).rejects.toSatisfy((e: unknown) => {
    if (!(e instanceof RadiusPaymentError) || e.code !== 'signer_unavailable') return false;
    const { message, ...details } = match;
    if (message && !message.test(e.message)) return false;
    return Object.entries(details).every(([k, v]) => (e.details as Record<string, unknown>)[k] === v);
  });

afterEach(() => vi.restoreAllMocks());

describe('proxySigner', () => {
  it('resolves the address once with the bearer token and extra headers, checksummed', async () => {
    const proxy = fakeProxy({ lowercase: true });
    const s = await signer(proxy, { headers: { 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'sec' } });
    expect(s.address).toBe(KEY.address);
    expect(s.alias).toBe(ALIAS);
    expect(s.url).toBe(URL_);
    expect(proxy.calls).toHaveLength(1);
    expect(proxy.calls[0]).toMatchObject({ method: 'GET', path: `/v1/wallets/${ALIAS}/address` });
    expect(proxy.calls[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(proxy.calls[0].headers.get('cf-access-client-id')).toBe('id');
    expect(proxy.calls[0].headers.get('cf-access-client-secret')).toBe('sec');
  });

  it('skips the lookup when the address is given, and strips a trailing slash from the URL', async () => {
    const proxy = fakeProxy();
    const s = await signer(proxy, { url: `${URL_}/`, address: KEY.address.toLowerCase() as Address });
    expect(s.address).toBe(KEY.address);
    expect(s.url).toBe(URL_);
    expect(proxy.calls).toHaveLength(0);
  });

  it('signs typed data through the proxy: bigints as decimal strings, EIP712Domain added, signature recovers to the wallet', async () => {
    const proxy = fakeProxy();
    const s = await signer(proxy);
    const typed = {
      domain: { name: 'Stable Coin', version: '1', chainId: 72344, verifyingContract: '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb' },
      types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'value', type: 'uint256' }] },
      primaryType: 'TransferWithAuthorization',
      message: { from: KEY.address, value: 13000n },
    } as const;
    const signature = await s.signTypedData(typed);
    expect(signature).toBe(await KEY.signTypedData(typed));
    const sent = proxy.calls[1];
    expect(sent).toMatchObject({ method: 'POST', path: `/v1/wallets/${ALIAS}/sign-typed-data` });
    expect(sent.headers.get('content-type')).toBe('application/json');
    const td = sent.body!.typedData as Record<string, unknown>;
    expect((td.message as Record<string, unknown>).value).toBe('13000');
    expect((td.types as Record<string, unknown>).EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ]);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(KEY.address);
  });

  it('signs text messages and raw hashes; refuses raw-byte messages', async () => {
    const proxy = fakeProxy();
    const s = await signer(proxy);
    const sig = await s.signMessage({ message: 'faucet challenge' });
    expect(await recoverMessageAddress({ message: 'faucet challenge', signature: sig })).toBe(KEY.address);
    expect(proxy.calls.at(-1)).toMatchObject({ path: `/v1/wallets/${ALIAS}/sign-message`, body: { message: 'faucet challenge' } });

    const hash = toHex(7n, { size: 32 });
    const hashSig = await s.signHash(hash);
    expect(await recoverAddress({ hash, signature: hashSig })).toBe(KEY.address);
    expect(proxy.calls.at(-1)).toMatchObject({ path: `/v1/wallets/${ALIAS}/sign-transaction`, body: { hash } });

    await unavailable(s.signMessage({ message: { raw: '0xdeadbeef' } }), { operation: 'sign-message', message: /text messages only/ });
    await expect(s.signHash('0x1234')).rejects.toMatchObject({ code: 'config' });
  });

  it('signs a transaction in JSON-RPC form with its CAIP-2 chain, after one capabilities read', async () => {
    const proxy = fakeProxy();
    const s = await signer(proxy);
    const tx = { chainId: 72344, nonce: 3, to: '0x000000000000000000000000000000000000dEaD' as Address, value: 1n, data: '0x' as Hex, gas: 21000n, gasPrice: 1_000_000_000n, type: 'legacy' as const };
    const signed = await s.signTransaction(tx);
    expect(signed).toBe(await KEY.signTransaction(tx));
    expect(parseTransaction(signed)).toMatchObject({ chainId: 72344, nonce: 3, to: tx.to.toLowerCase(), value: 1n });
    const [caps, sent] = proxy.calls.slice(-2);
    expect(caps).toMatchObject({ method: 'GET', path: `/v1/wallets/${ALIAS}/capabilities` });
    expect(sent.body).toMatchObject({
      caip2: 'eip155:72344',
      transaction: { chainId: '0x11a98', nonce: '0x3', to: tx.to, value: '0x1', gas: '0x5208', gasPrice: '0x3b9aca00', type: '0x0', from: KEY.address },
    });
    await s.signTransaction(tx);
    expect(proxy.calls.filter((c) => c.path.endsWith('/capabilities'))).toHaveLength(1);
  });

  it('refuses to sign transactions when the proxy says it cannot', async () => {
    const proxy = fakeProxy({ capabilities: { signTypedData: true, signTransaction: false } });
    const s = await signer(proxy);
    await unavailable(s.signTransaction({ chainId: 72344, nonce: 0, gas: 21000n, gasPrice: 1n, type: 'legacy' }), { operation: 'sign-transaction', message: /does not sign transactions/ });
    expect(proxy.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('maps the proxy answers and transport failures to signer_unavailable with details', async () => {
    await unavailable(signer(fakeProxy(), { token: 'wrong' }), { operation: 'address', status: 401, code: 'UNAUTHORIZED', message: /401 UNAUTHORIZED/ });
    await unavailable(signer(fakeProxy(), { alias: 'agent9-main' }), { alias: 'agent9-main', status: 404, code: 'WALLET_NOT_FOUND' });
    await unavailable(signer(fakeProxy({ offline: true })), { operation: 'address', message: /unreachable at https:\/\/wallet-proxy.test: fetch failed/ });

    // A proxy that answers 200 with something else than a signature.
    const odd = fakeProxy();
    const s = await signer(odd);
    const plain = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    const s2 = await proxySigner({ url: URL_, alias: ALIAS, address: KEY.address, fetch: plain });
    await unavailable(s2.signTypedData({ types: {}, primaryType: 'X', message: {} }), { operation: 'sign-typed-data', message: /non-JSON/ });
    const noSig = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
    const s3 = await proxySigner({ url: URL_, alias: ALIAS, address: KEY.address, fetch: noSig });
    await unavailable(s3.signMessage({ message: 'x' }), { message: /no signature/ });
    expect(s.address).toBe(KEY.address);
  });

  it('rejects bad options before any request', async () => {
    await expect(proxySigner({ url: 'ftp://x', alias: ALIAS })).rejects.toMatchObject({ code: 'config' });
    await expect(proxySigner({ url: URL_, alias: ' ' })).rejects.toMatchObject({ code: 'config' });
    await expect(proxySigner({ url: URL_, alias: ALIAS, address: '0x12' as Address })).rejects.toMatchObject({ code: 'config' });
  });

  it('proxySignerEnv reads radius-cli variable names', () => {
    expect(proxySignerEnv({ RADIUS_WALLET_PROXY_URL: URL_, RADIUS_WALLET_ALIAS: ALIAS })).toEqual({ url: URL_, alias: ALIAS });
    expect(proxySignerEnv({ RADIUS_WALLET_PROXY_URL: URL_, RADIUS_WALLET_ALIAS: ALIAS, RADIUS_WALLET_PROXY_TOKEN: TOKEN, CF_ACCESS_CLIENT_ID: 'id', CF_ACCESS_CLIENT_SECRET: 'sec' })).toEqual({
      url: URL_,
      alias: ALIAS,
      token: TOKEN,
      headers: { 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'sec' },
    });
    expect(() => proxySignerEnv({ RADIUS_WALLET_ALIAS: ALIAS })).toThrow(/RADIUS_WALLET_PROXY_URL/);
    expect(() => proxySignerEnv({ RADIUS_WALLET_PROXY_URL: URL_ })).toThrow(/RADIUS_WALLET_ALIAS/);
  });
});

// -- createRadiusFetch with the proxy as its signer ----------------------------------------------

const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;
const PAY_TO = '0x000000000000000000000000000000000000dEaD' as Address;
const CHAIN_ID = 84532;
const NETWORK = resolveNetwork('base-sepolia', { rpcUrl: 'http://127.0.0.1:1' });
const RESOURCE_URL = 'https://api.example.com/r';
const EXACT_EIP3009 = { scheme: 'exact', network: `eip155:${CHAIN_ID}`, asset: ASSET, payTo: PAY_TO, amount: '13000', maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' } };
const EXACT_PERMIT2 = { ...EXACT_EIP3009, extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
const fromB64 = (s: string) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const v2 = (accept: Record<string, unknown>) => ({ x402Version: 2, resource: { url: RESOURCE_URL, description: 'r' }, accepts: [accept] });

function seller(challenge: unknown) {
  const requests: Request[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req);
    if (req.headers.has('payment-signature')) return Response.json({ ok: true });
    return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': b64(challenge) } });
  }) as typeof fetch;
  return { fetch, requests };
}

/** Stub viem's JSON-RPC transport (global fetch) so the Permit2 allowance read never hits a node. */
function stubRpc() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const body = JSON.parse(await req.text()) as { id: number; method: string }[] | { id: number; method: string };
    const answer = (call: { id: number; method: string }) => {
      if (call.method === 'eth_chainId') return { jsonrpc: '2.0', id: call.id, result: toHex(CHAIN_ID) };
      if (call.method === 'eth_call') return { jsonrpc: '2.0', id: call.id, result: toHex(maxUint256, { size: 32 }) };
      return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `unstubbed ${call.method}` } };
    };
    return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
  });
}

describe('createRadiusFetch with a proxy signer', () => {
  it('pays an EIP-3009 offer: the authorization is from the proxy wallet and its signature recovers to it', async () => {
    const proxy = fakeProxy();
    const s = await signer(proxy);
    const server = seller(v2(EXACT_EIP3009));
    const offers: PaymentOffer[] = [];
    const payFetch = createRadiusFetch({ network: NETWORK, signer: s, maxPerRequest: { amount: '1000000' }, fetch: server.fetch, onPaymentRequired: (o) => (offers.push(o), true) });
    expect(payFetch.address).toBe(KEY.address);
    const res = await payFetch(RESOURCE_URL);
    expect(res.status).toBe(200);
    expect(offers).toHaveLength(1);
    const decoded = fromB64(server.requests[1].headers.get('payment-signature')!);
    const auth = decoded.payload.authorization;
    expect(auth.from).toBe(KEY.address);
    expect(auth.value).toBe('13000');
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: ASSET },
      types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
      primaryType: 'TransferWithAuthorization',
      message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
      signature: decoded.payload.signature,
    });
    expect(recovered).toBe(KEY.address);
    // One address lookup at creation, one signature for the payment, nothing else.
    expect(proxy.calls.map((c) => c.path.split('/').at(-1))).toEqual(['address', 'sign-typed-data']);
  });

  it('pays a Permit2 offer signed for the exact proxy', async () => {
    stubRpc();
    const proxy = fakeProxy();
    const s = await signer(proxy);
    const server = seller(v2(EXACT_PERMIT2));
    const payFetch = createRadiusFetch({ network: NETWORK, signer: s, maxPerRequest: { amount: '1000000' }, fetch: server.fetch });
    expect((await payFetch(RESOURCE_URL)).status).toBe(200);
    const decoded = fromB64(server.requests[1].headers.get('payment-signature')!);
    const a = decoded.payload.permit2Authorization;
    expect(a.from).toBe(KEY.address);
    expect(a.spender).toBe(X402_EXACT_PERMIT2_PROXY);
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2_ADDRESS },
      types: {
        PermitWitnessTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Witness' }],
        TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
        Witness: [{ name: 'to', type: 'address' }, { name: 'validAfter', type: 'uint256' }],
      },
      primaryType: 'PermitWitnessTransferFrom',
      message: { permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) }, spender: a.spender, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline), witness: { to: a.witness.to, validAfter: BigInt(a.witness.validAfter) } },
      signature: decoded.payload.signature,
    });
    expect(recovered).toBe(KEY.address);
  });

  it('asks the proxy for nothing when the offer is declined or over the limit', async () => {
    const proxy = fakeProxy();
    const s = await signer(proxy);
    const declined = createRadiusFetch({ network: NETWORK, signer: s, maxPerRequest: { amount: '1000000' }, fetch: seller(v2(EXACT_EIP3009)).fetch, onPaymentRequired: () => false });
    await expect(declined(RESOURCE_URL)).rejects.toMatchObject({ code: 'declined' });
    const capped = createRadiusFetch({ network: NETWORK, signer: s, maxPerRequest: { amount: '1' }, fetch: seller(v2(EXACT_EIP3009)).fetch });
    await expect(capped(RESOURCE_URL)).rejects.toMatchObject({ code: 'price_above_limit' });
    expect(proxy.calls).toHaveLength(1);
    expect(proxy.calls[0].path).toMatch(/\/address$/);
  });

  it('surfaces a proxy failure during signing as signer_unavailable', async () => {
    const proxy = fakeProxy();
    const s = await signer(proxy);
    proxy.offline = true;
    const payFetch = createRadiusFetch({ network: NETWORK, signer: s, maxPerRequest: { amount: '1000000' }, fetch: seller(v2(EXACT_EIP3009)).fetch });
    await unavailable(payFetch(RESOURCE_URL), { operation: 'sign-typed-data', alias: ALIAS });
  });
});
