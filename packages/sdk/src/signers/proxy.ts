/**
 * A signer backed by a wallet proxy: an HTTP service that holds the key (or the credentials of a
 * hosted wallet provider such as Privy, Coinbase CDP or Para) and signs on request, so an agent
 * runtime never holds a private key. The reference service is the Cloudflare Worker in
 * `radius-workshop/wallet-proxy`, whose API is:
 *
 *   GET  /v1/wallets/:alias/address            → { address }
 *   GET  /v1/wallets/:alias/capabilities       → { capabilities: { signTypedData, signTransaction, hashSigning, … } }
 *   POST /v1/wallets/:alias/sign-typed-data    { typedData }                → { signature }
 *   POST /v1/wallets/:alias/sign-message       { message }                  → { signature }
 *   POST /v1/wallets/:alias/sign-transaction   { hash } | { transaction }   → { signature } | { signedTransaction }
 *
 * Errors are `{ error: { code, message } }` with an HTTP status. Any failure to reach the proxy or
 * get a signature from it throws `RadiusPaymentError('signer_unavailable')`.
 *
 * The signer satisfies `ClientEvmSigner`, so it is a `signer` for `createRadiusFetch`. x402
 * `exact` and `upto` payments and MPP charges need only `signTypedData`; nothing is sent to the
 * proxy until the SDK signs, which is after the offer has passed `maxPerRequest` and
 * `onPaymentRequired`. Only the one `/address` lookup happens up front, when the signer is created.
 */
import { formatTransactionRequest, getAddress, getTypesForEIP712Domain, isAddress, type Address, type Hex, type SignableMessage, type TransactionSerializable, type TypedDataDomain } from 'viem';
import { RadiusPaymentError } from '../errors.js';

export interface ProxySignerOptions {
  /** Base URL of the wallet proxy, for example `https://wallet-proxy.example.workers.dev`. */
  url: string;
  /** The wallet alias the proxy maps to a provider wallet, for example `agent0-main`. */
  alias: string;
  /** Bearer token, sent as `Authorization: Bearer <token>` (`WALLET_PROXY_BEARER_TOKEN` on the Worker). */
  token?: string;
  /** Extra headers on every request, for example Cloudflare Access service-token headers. */
  headers?: Record<string, string>;
  /** The wallet's address, when already known: skips the `/address` lookup. */
  address?: Address;
  /** Underlying fetch (default `globalThis.fetch`). */
  fetch?: typeof fetch;
}

/** What the proxy says it can do for the alias (`GET /capabilities`). Unknown keys are kept. */
export interface ProxyCapabilities {
  signTypedData?: boolean;
  signMessage?: boolean;
  signTransaction?: boolean;
  /** Signing a raw 32-byte hash (what `sign-transaction` with `{ hash }` does). */
  hashSigning?: boolean;
  exportPrivateKey?: boolean;
  [key: string]: boolean | undefined;
}

/** The EIP-712 request shape `createRadiusFetch` and viem accounts hand to a signer. */
export interface ProxyTypedData {
  domain?: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface ProxySigner {
  /** The wallet's checksummed address. */
  readonly address: Address;
  readonly alias: string;
  readonly url: string;
  /** EIP-712 signature from the proxy. What x402 and MPP payments use. */
  signTypedData(typedData: ProxyTypedData): Promise<Hex>;
  /** EIP-191 `personal_sign` of a text message (the faucet challenge, `wallet sign`). */
  signMessage(parameters: { message: SignableMessage }): Promise<Hex>;
  /** Signature over a raw 32-byte hash, when the proxy's capabilities include `hashSigning`. */
  signHash(hash: Hex): Promise<Hex>;
  /**
   * A signed, serialized transaction, when the proxy's capabilities include `signTransaction`.
   * Pass a viem transaction (`chainId`, `nonce`, `gas`, fees, `to`, `value`, `data`); it is sent
   * in JSON-RPC form with its CAIP-2 chain.
   */
  signTransaction(transaction: TransactionSerializable): Promise<Hex>;
  /** The proxy's capabilities for the alias, fetched once. */
  capabilities(): Promise<ProxyCapabilities>;
}

/** Details on a `signer_unavailable` error: what was asked of which proxy, and what it answered. */
export interface ProxySignerErrorDetails {
  url: string;
  alias: string;
  operation: string;
  status?: number;
  code?: string;
  message?: string;
}

/**
 * Create a signer backed by a wallet proxy. Resolves the address once (one `GET /address`, unless
 * `address` is given), then signs through the proxy on demand.
 */
export async function proxySigner(options: ProxySignerOptions): Promise<ProxySigner> {
  const url = normalizeUrl(options.url);
  const alias = options.alias?.trim();
  if (!alias) throw new RadiusPaymentError('config', 'proxySigner: alias is required');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = { accept: 'application/json', ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const walletPath = `${url}/v1/wallets/${encodeURIComponent(alias)}`;

  const fail = (operation: string, message: string, extra: Partial<ProxySignerErrorDetails> = {}): RadiusPaymentError =>
    new RadiusPaymentError('signer_unavailable', message, { url, alias, operation, ...extra } satisfies ProxySignerErrorDetails);

  /** One call to the proxy; non-2xx answers and transport failures become `signer_unavailable`. */
  const call = async (operation: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await doFetch(`${walletPath}/${operation}`, {
        method: init.method,
        headers: init.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body, jsonReplacer),
      });
    } catch (e) {
      throw fail(operation, `wallet proxy unreachable at ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const err = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
      const code = typeof err?.code === 'string' ? err.code : undefined;
      const message = typeof err?.message === 'string' ? err.message : text.slice(0, 200) || res.statusText;
      throw fail(operation, `wallet proxy refused ${operation} for alias ${alias} (${res.status}${code ? ` ${code}` : ''}): ${message}`, { status: res.status, code, message });
    }
    if (!isRecord(parsed)) throw fail(operation, `wallet proxy returned a non-JSON response to ${operation}`, { status: res.status });
    return parsed;
  };

  const signatureFrom = (operation: string, body: Record<string, unknown>, key: 'signature' | 'signedTransaction'): Hex => {
    const value = body[key];
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw fail(operation, `wallet proxy returned no ${key} for ${operation}`, { status: 200 });
    return value as Hex;
  };

  let address: Address;
  if (options.address !== undefined) {
    if (!isAddress(options.address)) throw new RadiusPaymentError('config', `proxySigner: address is not a valid 0x address: ${options.address}`);
    address = getAddress(options.address);
  } else {
    const body = await call('address', { method: 'GET' });
    if (typeof body.address !== 'string' || !isAddress(body.address)) throw fail('address', `wallet proxy returned no address for alias ${alias}`, { status: 200 });
    address = getAddress(body.address);
  }

  let capabilitiesOnce: Promise<ProxyCapabilities> | undefined;
  const capabilities = (): Promise<ProxyCapabilities> =>
    (capabilitiesOnce ??= call('capabilities', { method: 'GET' }).then((body) => (isRecord(body.capabilities) ? (body.capabilities as ProxyCapabilities) : {})));

  return {
    address,
    alias,
    url,
    async signTypedData(typedData) {
      // Wallet providers (eth_signTypedData_v4) want EIP712Domain among the types; viem leaves it out.
      const domain = (typedData.domain ?? {}) as TypedDataDomain;
      const types = 'EIP712Domain' in typedData.types ? typedData.types : { EIP712Domain: getTypesForEIP712Domain({ domain }), ...typedData.types };
      const body = await call('sign-typed-data', { method: 'POST', body: { typedData: { domain, types, primaryType: typedData.primaryType, message: typedData.message } } });
      return signatureFrom('sign-typed-data', body, 'signature');
    },
    async signMessage({ message }) {
      if (typeof message !== 'string') throw fail('sign-message', 'the wallet proxy signs text messages only, not raw bytes');
      const body = await call('sign-message', { method: 'POST', body: { message } });
      return signatureFrom('sign-message', body, 'signature');
    },
    async signHash(hash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new RadiusPaymentError('config', `proxySigner: signHash needs a 32-byte hex hash, got ${hash}`);
      const body = await call('sign-transaction', { method: 'POST', body: { hash } });
      return signatureFrom('sign-transaction', body, 'signature');
    },
    async signTransaction(transaction) {
      const caps = await capabilities();
      if (caps.signTransaction === false) throw fail('sign-transaction', `the wallet proxy does not sign transactions for alias ${alias}`);
      const { chainId, ...rest } = transaction as TransactionSerializable & { chainId?: number };
      const rpc: Record<string, unknown> = { ...formatTransactionRequest(rest as Parameters<typeof formatTransactionRequest>[0]), from: address };
      if (chainId !== undefined) rpc.chainId = `0x${chainId.toString(16)}`;
      const body = await call('sign-transaction', { method: 'POST', body: { transaction: rpc, ...(chainId !== undefined ? { caip2: `eip155:${chainId}` } : {}) } });
      return signatureFrom('sign-transaction', body, 'signedTransaction');
    },
    capabilities,
  };
}

/**
 * Proxy signer options from environment-style variables, with radius-cli's names:
 *
 * | Variable                   | Maps to                                   |
 * | -------------------------- | ----------------------------------------- |
 * | RADIUS_WALLET_PROXY_URL    | url (required)                            |
 * | RADIUS_WALLET_ALIAS        | alias (required)                          |
 * | RADIUS_WALLET_PROXY_TOKEN  | token                                     |
 * | CF_ACCESS_CLIENT_ID        | headers['CF-Access-Client-Id']            |
 * | CF_ACCESS_CLIENT_SECRET    | headers['CF-Access-Client-Secret']        |
 *
 * `RADIUS_WALLET=proxy` is radius-cli's switch between its keystore and the proxy; this function
 * does not read it. Usage: `createRadiusFetch({ signer: await proxySigner(proxySignerEnv()), … })`.
 */
export function proxySignerEnv(env: Record<string, string | undefined> = defaultEnv()): ProxySignerOptions {
  const url = env.RADIUS_WALLET_PROXY_URL;
  const alias = env.RADIUS_WALLET_ALIAS;
  if (!url) throw new RadiusPaymentError('config', 'RADIUS_WALLET_PROXY_URL is required for the proxy wallet');
  if (!alias) throw new RadiusPaymentError('config', 'RADIUS_WALLET_ALIAS is required for the proxy wallet');
  const out: ProxySignerOptions = { url, alias };
  if (env.RADIUS_WALLET_PROXY_TOKEN) out.token = env.RADIUS_WALLET_PROXY_TOKEN;
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    out.headers = { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET };
  }
  return out;
}

function normalizeUrl(raw: string | undefined): string {
  const url = raw?.trim().replace(/\/+$/, '');
  if (!url || !/^https?:\/\//.test(url)) throw new RadiusPaymentError('config', `proxySigner: url must be an http(s) URL, got ${JSON.stringify(raw)}`);
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** viem hands EIP-712 messages with bigint fields; providers take them as decimal strings. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function defaultEnv(): Record<string, string | undefined> {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env ?? {};
}
