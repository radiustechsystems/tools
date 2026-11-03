import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAddress, type Address } from 'viem';
import { radiusMainnetChain, radiusTestnetChain, resolveNetwork, SBC, type PaymentNetwork } from 'radius-sdk';
import type { GlobalOptions, NetworkName, ResolvedConfig } from '../types.js';

const RADIUS_DIR = process.env.RADIUS_HOME ?? join(homedir(), '.radius');
const CONFIG_PATH = join(RADIUS_DIR, 'config.json');
const DEFAULT_KEYSTORE_PATH = join(RADIUS_DIR, 'keystore.json');

interface FileConfig {
  network?: NetworkName;
  rpcUrl?: string;
  sbcAddress?: string;
  rusdAddress?: string;
  cachedAddress?: string;
  passwordless?: boolean;
  /** Networks `wallet pay` pays on, in preference order (default ['radius']). */
  payNetworks?: string[];
  /** RPC URLs for non-Radius networks, by preset id: { "base": "https://…", "base-sepolia": "https://…" }. */
  rpcUrls?: { base?: string; 'base-sepolia'?: string };
}

function readFileConfig(): FileConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as FileConfig;
  } catch {
    return {};
  }
}

function pickAddress(value: string | undefined, label: string): Address | undefined {
  if (!value) return undefined;
  if (!isAddress(value)) throw new Error(`${label} is not a valid 0x address: ${value}`);
  return value;
}

export function resolveConfig(opts: GlobalOptions): ResolvedConfig {
  const file = readFileConfig();

  const networkRaw = opts.network ?? process.env.RADIUS_NETWORK ?? file.network ?? 'mainnet';
  if (networkRaw !== 'mainnet' && networkRaw !== 'testnet') {
    throw new Error(`--network must be 'mainnet' or 'testnet' (got '${networkRaw}')`);
  }
  const network = networkRaw as NetworkName;
  const chain = network === 'testnet' ? radiusTestnetChain : radiusMainnetChain;

  const rpcUrl = opts.rpcUrl ?? process.env.RADIUS_RPC_URL ?? file.rpcUrl ?? chain.rpcUrls.default.http[0];

  const sbcAddress =
    pickAddress(opts.sbc ?? process.env.RADIUS_SBC_ADDRESS ?? file.sbcAddress, 'SBC address') ??
    SBC.address;
  const rusdAddress = pickAddress(
    opts.rusd ?? process.env.RADIUS_RUSD_ADDRESS ?? file.rusdAddress,
    'RUSD address',
  );

  const keystorePath = process.env.RADIUS_KEYSTORE_PATH ?? DEFAULT_KEYSTORE_PATH;
  const password = process.env.RADIUS_PASSWORD;

  return { network, chain, rpcUrl, sbcAddress, rusdAddress, keystorePath, password };
}

/** The configured Radius network (mainnet or testnet) with the `--rpc-url` / `--sbc` overrides applied. */
export function radiusNetwork(cfg: ResolvedConfig): PaymentNetwork {
  return resolveNetwork(cfg.network, { rpcUrl: cfg.rpcUrl, asset: cfg.sbcAddress ? { address: cfg.sbcAddress } : undefined });
}

/** Networks `wallet pay` can pay on. `--network` picks mainnet or testnet for all of them. */
export const PAY_NETWORKS = ['radius', 'base'] as const;
export type PayNetworkName = (typeof PAY_NETWORKS)[number];

/**
 * The networks `wallet pay` pays on, in preference order: `--networks`, else RADIUS_PAY_NETWORKS,
 * else `payNetworks` in the config file, else Radius only. Radius takes `--rpc-url` / `--sbc`;
 * Base takes RADIUS_BASE_RPC_URL or `rpcUrls.base`, Base Sepolia RADIUS_BASE_SEPOLIA_RPC_URL or
 * `rpcUrls["base-sepolia"]`: separate settings, so a mainnet RPC is never used for testnet.
 */
export function resolvePayNetworks(cfg: ResolvedConfig, flag?: string): PaymentNetwork[] {
  const file = readFileConfig();
  const raw = flag ?? process.env.RADIUS_PAY_NETWORKS ?? file.payNetworks?.join(',') ?? 'radius';
  const names = [...new Set(raw.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean))];
  if (names.length === 0) throw new Error('--networks needs at least one network');
  return names.map((name) => {
    if (name === 'radius') return radiusNetwork(cfg);
    if (name === 'base') {
      const testnet = cfg.network === 'testnet';
      const rpcUrl = testnet ? (process.env.RADIUS_BASE_SEPOLIA_RPC_URL ?? file.rpcUrls?.['base-sepolia']) : (process.env.RADIUS_BASE_RPC_URL ?? file.rpcUrls?.base);
      return resolveNetwork(testnet ? 'base-sepolia' : 'base', rpcUrl ? { rpcUrl } : undefined);
    }
    throw new Error(`--networks: unknown network '${name}' (use ${PAY_NETWORKS.join(', ')})`);
  });
}

/** Where the Web Bot Auth key directory is hosted when RADIUS_SIGNATURE_AGENT is unset. */
export const DEFAULT_SIGNATURE_AGENT = 'https://radiustech.xyz';

export interface BotAuthConfig {
  /** Path to the Ed25519 private key (PKCS#8 PEM, or a JWK with `d`). */
  keyPath: string;
  /** Origin that serves /.well-known/http-message-signatures-directory for the key. */
  signatureAgent: string;
}

/**
 * Web Bot Auth request signing: on only when RADIUS_SIGNING_KEY names a key file, which the operator
 * supplies (a key shipped in the CLI would let anyone sign as it). RADIUS_SIGNATURE_AGENT is the
 * origin hosting its key directory. Separate from the wallet keystore.
 */
export function resolveBotAuthConfig(env: NodeJS.ProcessEnv = process.env): BotAuthConfig | undefined {
  const keyPath = env.RADIUS_SIGNING_KEY?.trim();
  if (!keyPath) return undefined;
  const raw = env.RADIUS_SIGNATURE_AGENT?.trim() || DEFAULT_SIGNATURE_AGENT;
  let agent: URL;
  try {
    agent = new URL(raw);
  } catch {
    throw new Error(`RADIUS_SIGNATURE_AGENT is not a URL: ${raw}`);
  }
  if (agent.protocol !== 'https:' && agent.protocol !== 'http:') {
    throw new Error(`RADIUS_SIGNATURE_AGENT must be an http(s) origin (got '${raw}')`);
  }
  return { keyPath, signatureAgent: agent.origin };
}

export function configPath(): string {
  return CONFIG_PATH;
}

export function radiusDir(): string {
  return RADIUS_DIR;
}

export function readCachedAddress(): Address | undefined {
  const file = readFileConfig();
  return pickAddress(file.cachedAddress, 'cached address');
}

function writeFileConfig(file: FileConfig): void {
  if (!existsSync(RADIUS_DIR)) mkdirSync(RADIUS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
}

export function writeCachedAddress(address: Address): void {
  const file = readFileConfig();
  file.cachedAddress = address;
  writeFileConfig(file);
}

export function readPasswordless(): boolean {
  return readFileConfig().passwordless === true;
}

export function writePasswordless(passwordless: boolean): void {
  const file = readFileConfig();
  if (passwordless) file.passwordless = true;
  else delete file.passwordless;
  writeFileConfig(file);
}
