import { sha256, type Hex, type LocalAccount } from 'viem';

const b64url = (data: string | Uint8Array) => Buffer.from(data).toString('base64url');

export interface JwtOptions {
  claims?: Record<string, unknown>;
  /** Lifetime in seconds from `now`. */
  expiresIn: number;
  /** Seconds since the epoch; defaults to the current time. */
  now?: number;
}

/**
 * Sign a compact JWT with the account's secp256k1 key (ES256K, RFC 8812: SHA-256 over the signing
 * input, signature as r||s). `iss` defaults to the account address; `iat` and `exp` are set from
 * `now` and `expiresIn` and cannot be overridden by `claims`.
 */
export async function signJwt(account: LocalAccount, { claims = {}, expiresIn, now = Math.floor(Date.now() / 1000) }: JwtOptions): Promise<string> {
  if (!Number.isInteger(expiresIn) || expiresIn <= 0) throw new Error('--expires-in must be a positive number of seconds');
  if (typeof account.sign !== 'function') throw new Error('wallet sign-jwt needs an account that signs raw hashes');
  const header = { alg: 'ES256K', typ: 'JWT' };
  const payload = { iss: account.address, ...claims, iat: now, exp: now + expiresIn };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig: Hex = await account.sign({ hash: sha256(Buffer.from(signingInput)) });
  // viem returns r||s||v; ES256K carries r||s only.
  return `${signingInput}.${b64url(Buffer.from(sig.slice(2, 130), 'hex'))}`;
}
