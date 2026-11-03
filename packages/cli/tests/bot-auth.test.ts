import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verify } from 'web-bot-auth';
import { verifierFromJWK } from 'web-bot-auth/crypto';

const dir = mkdtempSync(join(tmpdir(), 'radius-cli-bot-auth-'));
const { privateKey } = generateKeyPairSync('ed25519');
const jwk = privateKey.export({ format: 'jwk' });
const pemPath = join(dir, 'key.pem');
writeFileSync(pemPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
const jwkPath = join(dir, 'key.jwk');
writeFileSync(jwkPath, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', d: jwk.d }));

// botAuthFetch (used by runRequest) reads the environment once, on first use.
process.env.RADIUS_HOME = dir;
process.env.RADIUS_SIGNING_KEY = pemPath;
process.env.RADIUS_SIGNATURE_AGENT = 'https://agent.example/ignored-path';

const { resolveBotAuthConfig, DEFAULT_SIGNATURE_AGENT } = await import('../src/lib/config.js');
const { keyDirectory, loadBotAuth, readSigningKey, signedFetch, SIGNATURE_TTL_SECONDS } = await import('../src/lib/botAuth.js');
const { runRequest } = await import('../src/lib/http.js');

/** RFC 7638 thumbprint of an Ed25519 JWK, computed independently of the library. */
function thumbprint(x: string): string {
  return createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })).digest('base64url');
}

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

async function listen(handler: (seen: Seen, res: import('node:http').ServerResponse) => void): Promise<{ base: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      const s = { method: req.method!, url: req.url!, headers: req.headers, body };
      seen.push(s);
      handler(s, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

/** Verifies the request a server received with web-bot-auth's verifier and the public key only. */
async function verifySeen(s: Seen) {
  const verifier = await verifierFromJWK({ kty: 'OKP', crv: 'Ed25519', x: jwk.x });
  const headers = new Headers();
  for (const [k, v] of Object.entries(s.headers)) if (typeof v === 'string') headers.set(k, v);
  return verify(new Request(`http://${s.headers.host}${s.url}`, { headers }), {
    resolver: (candidate) => {
      if (candidate.keyid !== verifier.keyid) throw new Error('unknown key');
      return verifier;
    },
  });
}

describe('resolveBotAuthConfig', () => {
  it('is off without RADIUS_SIGNING_KEY', () => {
    expect(resolveBotAuthConfig({})).toBeUndefined();
    expect(resolveBotAuthConfig({ RADIUS_SIGNING_KEY: ' ' })).toBeUndefined();
  });

  it('defaults the signature agent and keeps only an origin', () => {
    expect(resolveBotAuthConfig({ RADIUS_SIGNING_KEY: '/k' })).toEqual({ keyPath: '/k', signatureAgent: DEFAULT_SIGNATURE_AGENT });
    expect(resolveBotAuthConfig({ RADIUS_SIGNING_KEY: '/k', RADIUS_SIGNATURE_AGENT: 'https://a.example/x?y' })?.signatureAgent).toBe('https://a.example');
  });

  it('rejects a signature agent that is not an http(s) URL', () => {
    expect(() => resolveBotAuthConfig({ RADIUS_SIGNING_KEY: '/k', RADIUS_SIGNATURE_AGENT: 'nope' })).toThrow(/not a URL/);
    expect(() => resolveBotAuthConfig({ RADIUS_SIGNING_KEY: '/k', RADIUS_SIGNATURE_AGENT: 'ftp://a.example' })).toThrow(/http\(s\)/);
  });
});

describe('readSigningKey', () => {
  it('reads PKCS#8 PEM and a JWK with only d to the same key', () => {
    const fromPem = readSigningKey(pemPath).export({ format: 'jwk' });
    const fromJwk = readSigningKey(jwkPath).export({ format: 'jwk' });
    expect(fromPem.x).toBe(jwk.x);
    expect(fromJwk.x).toBe(jwk.x);
  });

  it('rejects other keys without quoting the file', () => {
    const secret = 'super-secret-key-material';
    const garbage = join(dir, 'garbage');
    writeFileSync(garbage, `{"kty":"OKP","crv":"Ed25519","d":"${secret}"`);
    expect(() => readSigningKey(garbage)).toThrow(/not an Ed25519 private key/);
    try {
      readSigningKey(garbage);
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
    const ec = join(dir, 'ec.pem');
    writeFileSync(ec, generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }));
    expect(() => readSigningKey(ec)).toThrow(/not an Ed25519 private key/);
    const wrongX = join(dir, 'wrong-x.jwk');
    writeFileSync(wrongX, JSON.stringify({ ...jwk, x: generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x }));
    expect(() => readSigningKey(wrongX)).toThrow(/not an Ed25519 private key/);
    expect(() => readSigningKey(join(dir, 'missing'))).toThrow(/cannot read/);
  });
});

describe('keyDirectory', () => {
  it('lists the public key only, with its RFC 7638 thumbprint as kid', async () => {
    const auth = await loadBotAuth({ keyPath: jwkPath, signatureAgent: 'https://agent.example' });
    expect(auth.signer.keyid).toBe(thumbprint(jwk.x!));
    expect(keyDirectory(auth)).toEqual({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: thumbprint(jwk.x!) }] });
    expect(JSON.stringify(keyDirectory(auth))).not.toContain(jwk.d!);
  });
});

describe('signedFetch', () => {
  let auth: Awaited<ReturnType<typeof loadBotAuth>>;
  beforeAll(async () => {
    auth = await loadBotAuth({ keyPath: pemPath, signatureAgent: 'https://agent.example' });
  });

  it('signs @authority and signature-agent with a short-lived, tagged signature that verifies', async () => {
    const { base, seen, server } = await listen((_s, res) => res.writeHead(200).end('ok'));
    try {
      const res = await signedFetch(auth, `${base}/r?q=1`);
      expect(res.status).toBe(200);
      const s = seen[0]!;
      expect(s.headers['signature-agent']).toBe('"https://agent.example"');
      expect(s.headers['signature-input']).toMatch(/^sig1=\("@authority" "signature-agent"\);/);
      expect(s.headers['signature-input']).toContain(`keyid="${thumbprint(jwk.x!)}"`);
      expect(s.headers['signature-input']).toContain('alg="ed25519"');
      expect(s.headers['signature-input']).toContain('tag="web-bot-auth"');
      expect(s.headers.signature).toMatch(/^sig1=:[A-Za-z0-9+/]+=*:$/);
      const verified = await verifySeen(s);
      expect(verified.signatureAgent?.uri).toBe('https://agent.example');
      expect((verified.expires.getTime() - verified.created.getTime()) / 1000).toBe(SIGNATURE_TTL_SECONDS);
    } finally {
      server.close();
    }
  });

  it('re-signs each redirect hop for its own origin and leaves credentials behind', async () => {
    const b = await listen((_s, res) => res.writeHead(200).end('final'));
    const a = await listen((_s, res) => res.writeHead(302, { location: `${b.base}/final` }).end());
    try {
      const res = await signedFetch(auth, `${a.base}/start`, { headers: { authorization: 'Bearer t' } });
      expect([res.status, res.url, await res.text()]).toEqual([200, `${b.base}/final`, 'final']);
      expect(a.seen[0]!.headers.authorization).toBe('Bearer t');
      expect(b.seen[0]!.headers.authorization).toBeUndefined();
      await verifySeen(a.seen[0]!);
      await verifySeen(b.seen[0]!);
      expect(b.seen[0]!.headers['signature-input']).not.toBe(a.seen[0]!.headers['signature-input']);
    } finally {
      a.server.close();
      b.server.close();
    }
  });

  it('follows redirects as fetch does: 307 replays the body, 303 becomes a GET', async () => {
    const { base, seen, server } = await listen((s, res) => {
      if (s.url === '/a') res.writeHead(307, { location: '/b' }).end();
      else if (s.url === '/b') res.writeHead(303, { location: '/c' }).end();
      else res.writeHead(200).end();
    });
    try {
      const res = await signedFetch(auth, `${base}/a`, { method: 'POST', body: new Blob(['{"a":1}']), headers: { 'content-type': 'application/json' } });
      expect(res.status).toBe(200);
      expect(seen.map((s) => `${s.method} ${s.url} ${s.body}`)).toEqual(['POST /a {"a":1}', 'POST /b {"a":1}', 'GET /c ']);
      expect(seen[2]!.headers['content-type']).toBeUndefined();
      for (const s of seen) await verifySeen(s);
    } finally {
      server.close();
    }
  });

  it("returns a redirect unfollowed when the caller asked for redirect: 'manual'", async () => {
    const { base, seen, server } = await listen((_s, res) => res.writeHead(302, { location: '/elsewhere' }).end());
    try {
      const res = await signedFetch(auth, `${base}/r`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(seen).toHaveLength(1);
      await verifySeen(seen[0]!);
    } finally {
      server.close();
    }
  });
});

describe('runRequest with RADIUS_SIGNING_KEY set', () => {
  let srv: Awaited<ReturnType<typeof listen>>;
  beforeAll(async () => {
    srv = await listen((_s, res) => res.writeHead(402).end());
  });
  afterAll(() => srv.server.close());

  it('signs the request with the configured key and signature agent origin', async () => {
    const res = await runRequest('get', `${srv.base}/paid`, { headers: new Headers() });
    expect(res.status).toBe(402);
    const verified = await verifySeen(srv.seen[0]!);
    expect(verified.keyid).toBe(thumbprint(jwk.x!));
    expect(verified.signatureAgent?.uri).toBe('https://agent.example');
  });
});
