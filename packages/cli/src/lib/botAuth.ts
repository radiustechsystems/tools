import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { generateNonce, HTTP_MESSAGE_SIGNATURES_DIRECTORY, sign, type WebBotSigner } from 'web-bot-auth';
import { signerFromJWK } from 'web-bot-auth/crypto';
import { resolveBotAuthConfig, type BotAuthConfig } from './config.js';

// Web Bot Auth (Cloudflare's profile of RFC 9421 HTTP message signatures, Ed25519): each request
// carries Signature-Agent, Signature-Input and Signature, covering @authority and signature-agent.

/** How long a signature stays valid after it is made. */
export const SIGNATURE_TTL_SECONDS = 60;
export const DIRECTORY_PATH = HTTP_MESSAGE_SIGNATURES_DIRECTORY;
export const DIRECTORY_CONTENT_TYPE = 'application/http-message-signatures-directory+json';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
// PKCS#8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410), for JWKs that carry only `d`.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface BotAuth {
  signer: WebBotSigner;
  /** Public key as a JWK: kty, crv, x. */
  publicJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string };
  /** Origin of the key directory, sent as the Signature-Agent sf-string. */
  signatureAgent: string;
}

/**
 * Reads an Ed25519 private key from a PKCS#8 PEM file or a JWK JSON file with `d`. Errors never quote
 * the file: it holds the private key.
 */
export function readSigningKey(path: string): KeyObject {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`RADIUS_SIGNING_KEY: cannot read ${path} (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  const invalid = new Error(`RADIUS_SIGNING_KEY: ${path} is not an Ed25519 private key (PKCS#8 PEM, or a JWK with "d")`);
  let key: KeyObject;
  try {
    if (text.trimStart().startsWith('{')) {
      const jwk = JSON.parse(text) as JsonWebKey;
      if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string') throw invalid;
      const seed = Buffer.from(jwk.d, 'base64url');
      if (seed.length !== 32) throw invalid;
      key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
      if (jwk.x !== undefined && key.export({ format: 'jwk' }).x !== jwk.x) throw invalid;
    } else {
      key = createPrivateKey(text);
    }
  } catch {
    throw invalid;
  }
  if (key.asymmetricKeyType !== 'ed25519') throw invalid;
  return key;
}

export async function loadBotAuth(cfg: BotAuthConfig): Promise<BotAuth> {
  const jwk = readSigningKey(cfg.keyPath).export({ format: 'jwk' });
  const signer = await signerFromJWK(jwk);
  return { signer, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x as string }, signatureAgent: cfg.signatureAgent };
}

/** The key directory to serve at `<origin>/.well-known/http-message-signatures-directory`. */
export function keyDirectory(auth: BotAuth): { keys: Array<BotAuth['publicJwk'] & { kid: string }> } {
  return { keys: [{ ...auth.publicJwk, kid: auth.signer.keyid }] };
}

/** Signature-Agent, Signature-Input and Signature for a request to `url`. */
export async function signatureHeaders(auth: BotAuth, url: string | URL, now = new Date()): Promise<Record<string, string>> {
  const agent = `"${auth.signatureAgent}"`; // sf-string; an origin has no quote or backslash
  const { signature, signatureInput } = await sign(new Request(url, { headers: { 'Signature-Agent': agent } }), {
    signer: auth.signer,
    created: now,
    expires: new Date(now.getTime() + SIGNATURE_TTL_SECONDS * 1000),
    nonce: generateNonce(),
  });
  return { 'Signature-Agent': agent, 'Signature-Input': signatureInput, Signature: signature };
}

/**
 * fetch that signs every request. The signature covers @authority, so redirects are followed here,
 * signing each hop for its own origin, instead of letting fetch resend one signature elsewhere. Hops
 * follow fetch's rules: 303 (and a 301/302 POST) becomes a GET, Authorization and Cookie stay behind on
 * another origin. The response's `url` is the last hop; `redirected` is always false.
 */
export async function signedFetch(
  auth: BotAuth,
  input: RequestInfo | URL,
  init?: RequestInit,
  base: typeof fetch = fetch,
): Promise<Response> {
  let request = new Request(input, init);
  const follow = request.redirect === 'follow';
  for (let hop = 0; ; hop++) {
    const replay = follow ? request.clone() : undefined;
    const headers = new Headers(request.headers);
    for (const [k, v] of Object.entries(await signatureHeaders(auth, request.url))) headers.set(k, v);
    const res = await base(new Request(request, { headers, redirect: follow ? 'manual' : request.redirect }));
    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null;
    if (!replay || !location) return res;
    if (hop >= MAX_REDIRECTS) throw new TypeError('fetch failed: too many redirects');
    await res.body?.cancel();
    const next = new URL(location, request.url);
    const nextHeaders = new Headers(replay.headers);
    if (next.origin !== new URL(request.url).origin) ['authorization', 'cookie', 'proxy-authorization'].forEach((h) => nextHeaders.delete(h));
    const method = replay.method;
    const toGet = res.status === 303 ? method !== 'GET' && method !== 'HEAD' : (res.status === 301 || res.status === 302) && method === 'POST';
    if (toGet) ['content-encoding', 'content-language', 'content-location', 'content-type'].forEach((h) => nextHeaders.delete(h));
    const body = !toGet && method !== 'GET' && method !== 'HEAD' ? await replay.arrayBuffer() : undefined;
    request = new Request(next, { method: toGet ? 'GET' : method, headers: nextHeaders, body, signal: replay.signal });
  }
}

let configured: Promise<BotAuth | undefined> | undefined;

/** The signing key from RADIUS_SIGNING_KEY, loaded once; undefined when signing is off. */
export function configuredBotAuth(): Promise<BotAuth | undefined> {
  configured ??= (async () => {
    const cfg = resolveBotAuthConfig();
    return cfg ? loadBotAuth(cfg) : undefined;
  })();
  return configured;
}

/** fetch for outgoing HTTP requests: signed when RADIUS_SIGNING_KEY is set, plain fetch otherwise. */
export const botAuthFetch: typeof fetch = async (input, init) => {
  const auth = await configuredBotAuth();
  return auth ? signedFetch(auth, input, init) : fetch(input, init);
};
