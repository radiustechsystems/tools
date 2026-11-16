import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAddress, type Address } from 'viem';
import { counterpartOf, NETWORK_ALIASES, PRESET_NETWORKS, radiusMainnetChain, radiusTestnetChain, resolveNetwork, SBC, type PaymentNetwork, type PresetName } from 'radius-sdk';
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
  /** Networks `wallet pay` pays on, in preference order (default ['radius']); mainnet preset ids (see `PAY_NETWORKS`). */
  payNetworks?: string[];
  /** RPC URLs for non-Radius networks, by preset id: { "base": "https://…", "base-sepolia": "https://…" }. */
  rpcUrls?: Partial<Record<RpcPreset, string>>;
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

/** The mainnet presets `wallet pay` can pay on (`radius`, `base`); `--network testnet` swaps each for its testnet counterpart. */
const PAY_PRESETS: readonly PaymentNetwork[] = PRESET_NETWORKS.filter((n) => !n.testnet);
/** Networks `wallet pay` can pay on, by mainnet preset id. `--network` picks mainnet or testnet for all of them. */
export const PAY_NETWORKS: readonly PresetName[] = PAY_PRESETS.map((n) => n.name as PresetName);

/** The presets whose RPC `rpcUrls` / `RADIUS_<PRESET>_RPC_URL` set: every one but Radius, which `rpcUrl` sets. */
export type RpcPreset = Exclude<PresetName, (typeof NETWORK_ALIASES)[keyof typeof NETWORK_ALIASES]>;

/** `RADIUS_BASE_SEPOLIA_RPC_URL` for `base-sepolia`: the env var that overrides a preset's RPC. */
function rpcUrlEnvVar(preset: PaymentNetwork): string {
  return `RADIUS_${preset.name.toUpperCase().replace(/-/g, '_')}_RPC_URL`;
}

/**
 * The networks `wallet pay` pays on, in preference order: `--networks`, else RADIUS_PAY_NETWORKS,
 * else `payNetworks` in the config file, else Radius only. Each name is a mainnet preset, swapped
 * for its testnet counterpart under `--network testnet`. Radius takes `--rpc-url` / `--sbc`; every
 * other preset takes `RADIUS_<PRESET>_RPC_URL` (`RADIUS_BASE_RPC_URL`, `RADIUS_BASE_SEPOLIA_RPC_URL`)
 * or `rpcUrls["<preset>"]` in the config file: separate settings per preset, so a mainnet RPC is
 * never used for testnet.
 */
export function resolvePayNetworks(cfg: ResolvedConfig, flag?: string): PaymentNetwork[] {
  const file = readFileConfig();
  const raw = flag ?? process.env.RADIUS_PAY_NETWORKS ?? file.payNetworks?.join(',') ?? 'radius';
  const names = [...new Set(raw.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean))];
  if (names.length === 0) throw new Error('--networks needs at least one network');
  return names.map((name) => {
    const mainnet = PAY_PRESETS.find((n) => n.name === name);
    if (!mainnet) throw new Error(`--networks: unknown network '${name}' (use ${PAY_NETWORKS.join(', ')})`);
    const preset = cfg.network === 'testnet' ? counterpartOf(mainnet) : mainnet;
    if (!preset) throw new Error(`--networks: ${name} has no testnet counterpart`);
    if (preset.radius) return radiusNetwork(cfg);
    const rpcUrl = process.env[rpcUrlEnvVar(preset)] ?? file.rpcUrls?.[preset.name as RpcPreset];
    return resolveNetwork(preset.name as PresetName, rpcUrl ? { rpcUrl } : undefined);
  });
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
