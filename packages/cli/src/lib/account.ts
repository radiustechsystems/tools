import { password as promptPassword } from '@inquirer/prompts';
import { generatePrivateKey, privateKeyToAccount, toAccount } from 'viem/accounts';
import type { Hex, LocalAccount, PrivateKeyAccount } from 'viem';
import { proxySigner, proxySignerEnv, type ProxySigner } from 'radius-sdk/signers/proxy';
import { keystoreExists, loadAccount, readKeystoreAddress, saveKeystore } from './keystore.js';
import { readPasswordless, writeCachedAddress, writePasswordless } from './config.js';
import type { ResolvedConfig } from '../types.js';

function normalizePrivateKey(input: string): Hex {
  const trimmed = input.trim();
  const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error('--private-key must be a 32-byte hex string (64 hex chars, optional 0x prefix).');
  }
  return withPrefix as Hex;
}

async function resolvePassword(cfg: ResolvedConfig): Promise<string> {
  if (cfg.password !== undefined) return cfg.password;
  if (readPasswordless()) return '';
  return await promptPassword({ message: 'Keystore password:', mask: '*' });
}

/**
 * Generate a fresh keystore on first use. Uses RADIUS_PASSWORD if set, empty otherwise.
 * An empty password means the keystore JSON is effectively unencrypted — the file mode
 * (0o600) is the only protection. The notice on stderr makes that clear.
 */
async function autoCreateKeystore(cfg: ResolvedConfig): Promise<PrivateKeyAccount> {
  const pk = generatePrivateKey();
  const password = cfg.password ?? '';
  const address = await saveKeystore(cfg.keystorePath, pk, password);
  writeCachedAddress(address);
  writePasswordless(password === '');

  const lines = [
    `Created new keystore at ${cfg.keystorePath}`,
    `Address: ${address}`,
  ];
  if (password === '') {
    lines.push(
      'No password set — keystore is effectively unencrypted (file mode 0o600).',
      'To add one and keep this address: `radius-cli wallet password` (set RADIUS_NEW_PASSWORD to skip the prompt).',
      'To set one at creation instead, set RADIUS_PASSWORD before the first command.',
    );
  }
  process.stderr.write(lines.join('\n') + '\n');

  return privateKeyToAccount(pk);
}

/**
 * The wallet proxy signer for RADIUS_WALLET=proxy, built once per process from
 * RADIUS_WALLET_PROXY_URL, RADIUS_WALLET_ALIAS, RADIUS_WALLET_PROXY_TOKEN and the Cloudflare Access
 * variables (see `proxySignerEnv`). Creating it is one `GET /address`; every signature is a
 * request to the proxy, which holds the key.
 */
let proxyOnce: Promise<ProxySigner> | undefined;
function loadProxySigner(): Promise<ProxySigner> {
  return (proxyOnce ??= proxySigner(proxySignerEnv(process.env)));
}

/** Reset the per-process proxy signer (tests). */
export function resetProxySigner(): void {
  proxyOnce = undefined;
}

/**
 * A viem local account whose every signature comes from the wallet proxy. `signTransaction` lets
 * `wallet send` go through the proxy when it signs transactions (its `capabilities` say so);
 * `sign` (a raw hash) is what `wallet sign-jwt` needs.
 */
async function proxyAccount(): Promise<LocalAccount> {
  const signer = await loadProxySigner();
  return toAccount({
    address: signer.address,
    sign: ({ hash }) => signer.signHash(hash),
    signMessage: ({ message }) => signer.signMessage({ message }),
    signTransaction: (transaction) => signer.signTransaction(transaction),
    signTypedData: (data) => signer.signTypedData(data as Parameters<ProxySigner['signTypedData']>[0]),
  });
}

/**
 * Refuse a keystore-only command under RADIUS_WALLET=proxy. `what` names the command, for example
 * `wallet export`.
 */
export function assertKeystoreWallet(cfg: ResolvedConfig, what: string): void {
  if (cfg.wallet !== 'proxy') return;
  throw new Error(
    `${what} is not available with RADIUS_WALLET=proxy: the wallet proxy holds the key and does not export or replace it. Unset RADIUS_WALLET to use the local keystore.`,
  );
}

/**
 * Returns a viem local account. `--private-key` wins; then the wallet proxy under
 * RADIUS_WALLET=proxy; else the keystore, auto-created on first use, with a password prompt if
 * one exists.
 */
export async function requireAccount(
  cfg: ResolvedConfig,
  privateKeyOpt: string | undefined,
): Promise<LocalAccount> {
  if (privateKeyOpt) {
    return privateKeyToAccount(normalizePrivateKey(privateKeyOpt));
  }
  if (cfg.wallet === 'proxy') {
    return await proxyAccount();
  }
  if (!keystoreExists(cfg.keystorePath)) {
    return await autoCreateKeystore(cfg);
  }
  const password = await resolvePassword(cfg);
  return await loadAccount(cfg.keystorePath, password);
}

/**
 * Returns just the address — no password prompt. Auto-creates a keystore on first use; with the
 * wallet proxy, asks it for the alias's address.
 */
export async function getOwnAddress(
  cfg: ResolvedConfig,
  privateKeyOpt: string | undefined,
): Promise<`0x${string}`> {
  if (privateKeyOpt) {
    return privateKeyToAccount(normalizePrivateKey(privateKeyOpt)).address;
  }
  if (cfg.wallet === 'proxy') {
    return (await loadProxySigner()).address;
  }
  const addr = readKeystoreAddress(cfg.keystorePath);
  if (addr) return addr;
  return (await autoCreateKeystore(cfg)).address;
}

/**
 * An account whose address is known now but whose key is loaded — password prompt and all — only
 * when something is signed. `wallet pay` hands this to the SDK so a 402 is parsed and matched
 * (network, asset, scheme, payTo) before the keystore is unlocked; a bad challenge never prompts.
 * With --private-key the key is already in hand. With the wallet proxy, the address is looked up
 * now and the proxy is asked to sign only once an offer has been accepted. Auto-creates a keystore
 * on first use.
 */
export async function deferredAccount(
  cfg: ResolvedConfig,
  privateKeyOpt: string | undefined,
): Promise<LocalAccount> {
  if (privateKeyOpt) {
    return privateKeyToAccount(normalizePrivateKey(privateKeyOpt));
  }
  if (cfg.wallet === 'proxy') {
    return await proxyAccount();
  }
  const address = await getOwnAddress(cfg, undefined);
  let loading: Promise<LocalAccount> | undefined;
  const load = () => (loading ??= requireAccount(cfg, undefined));
  return toAccount({
    address,
    signMessage: async (args) => (await load()).signMessage(args),
    signTransaction: async (tx, options) => (await load()).signTransaction(tx, options),
    signTypedData: async (data) => (await load()).signTypedData(data),
  });
}
