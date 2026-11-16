/**
 * Payment networks: where a payment settles and in which token.
 *
 * Chain identity (id, RPC, explorer, native currency) is a viem `Chain`, defined here inline
 * with the same values as viem's own entries. They are not imported from `viem/chains`: that
 * barrel loads several hundred chain definitions and costs a CLI ~400 ms of startup. A
 * `PaymentNetwork` wraps a chain with what x402 needs (payment asset, default facilitator,
 * x402 v1 network names) and exposes a few fields derived from the chain for convenience.
 *
 * Presets: Radius mainnet and testnet (the default), Base and Base Sepolia, each paired with its
 * counterpart in the other tier (`counterpart`). Every preset defaults to a Radius facilitator:
 * `facilitator.radiustech.xyz` settles Radius and Base, `facilitator.testnet.radiustech.xyz`
 * Radius testnet and Base Sepolia. Any other EVM chain is one `definePaymentNetwork()` call away.
 * To add a preset: a name in `PRESET_NAMES`, a `definePaymentNetwork()` literal and its entry
 * in `PRESET_NETWORKS`; `NetworkName`, `PRESETS_BY_NAME` and `NETWORK_NAMES` follow.
 *
 * Radius values verified against docs.radiustech.xyz and the live facilitator `/supported`
 * responses (2026-09-11); Base USDC values match @x402/evm's default assets. Facilitator
 * defaults follow the Radius platform catalog (2026-11-12).
 */

import type { Chain } from 'viem';

// Plain Chain objects keep root and seller imports independent of viem at runtime.

export type Address = `0x${string}`;
export type Caip2 = `eip155:${number}`;

export interface PaymentAsset {
  /** ERC-20 contract address. */
  address: Address;
  symbol: string;
  decimals: number;
  /** EIP-712 domain name (EIP-3009 / EIP-2612). */
  name: string;
  /** EIP-712 domain version (EIP-3009 / EIP-2612). */
  version: string;
}

export interface PaymentNetwork {
  /** Preset id ('radius', 'radius-testnet', 'base', 'base-sepolia') or a custom network's name. */
  name: string;
  /**
   * The viem chain — the source of truth for chain id, RPC, explorer and native
   * currency. Pass it to `createPublicClient` / `createWalletClient`.
   */
  chain: Chain;
  /** `chain.id`. */
  chainId: number;
  /** CAIP-2 identifier used on the x402 wire, e.g. `eip155:723487` (from `chain.id`). */
  network: Caip2;
  /** `chain.rpcUrls.default.http[0]`. */
  rpcUrl: string;
  /**
   * Facilitator sellers use when they do not name one. Every preset names a Radius facilitator
   * (the mainnet one for Radius and Base, the testnet one for Radius testnet and Base Sepolia);
   * a custom network without one makes sellers choose a facilitator.
   */
  facilitatorUrl?: string;
  /** `chain.blockExplorers.default.url`, when the chain declares one. */
  explorerUrl?: string;
  /** Radius faucet API base URL (drips SBC; testnet ~0.5/request, mainnet ~0.01/day). */
  faucetUrl?: string;
  /** Payment asset: SBC on Radius, USDC on Base. */
  asset: PaymentAsset;
  /** `chain.testnet ?? false`. */
  testnet: boolean;
  /**
   * A Radius network: `eth_getBalance` includes convertible stablecoins (the Turnstile) and gas
   * can be paid in SBC. False for every other chain.
   */
  radius: boolean;
  /** Names x402 v1 challenges use for this network instead of CAIP-2 (e.g. `base`). */
  v1Names: readonly string[];
  /**
   * The preset in the other tier: the testnet of a mainnet preset and vice versa
   * (`radius` ↔ `radius-testnet`, `base` ↔ `base-sepolia`). Unset for custom networks.
   */
  counterpart?: PresetName;
}

/** Radius mainnet (id 723487). Same values as viem's `radius`. */
export const radiusMainnetChain: Chain = {
  id: 723_487,
  name: 'Radius Network',
  nativeCurrency: { name: 'Radius USD', symbol: 'RUSD', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.radiustech.xyz'] } },
  blockExplorers: { default: { name: 'Radius Network Explorer', url: 'https://network.radiustech.xyz' } },
  testnet: false,
};

/** Radius testnet (id 72344). Same values as viem's `radiusTestnet`. */
export const radiusTestnetChain: Chain = {
  id: 72_344,
  name: 'Radius Test Network',
  nativeCurrency: { name: 'Radius USD', symbol: 'RUSD', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.radiustech.xyz'] } },
  blockExplorers: { default: { name: 'Radius Test Network Explorer', url: 'https://testnet.radiustech.xyz' } },
  testnet: true,
};

/** Base (id 8453). Same values as viem's `base`. */
export const baseChain: Chain = {
  id: 8453,
  name: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://mainnet.base.org'] } },
  blockExplorers: { default: { name: 'Basescan', url: 'https://basescan.org' } },
  testnet: false,
};

/** Base Sepolia (id 84532). Same values as viem's `baseSepolia`. */
export const baseSepoliaChain: Chain = {
  id: 84_532,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia.base.org'] } },
  blockExplorers: { default: { name: 'Basescan', url: 'https://sepolia.basescan.org' } },
  testnet: true,
};

/** SBC is deployed deterministically: same address on Radius mainnet and testnet. */
export const SBC: PaymentAsset = {
  address: '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb',
  symbol: 'SBC',
  decimals: 6,
  name: 'Stable Coin',
  version: '1',
};

/** Circle USDC on Base. */
export const USDC_BASE: PaymentAsset = {
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  symbol: 'USDC',
  decimals: 6,
  name: 'USD Coin',
  version: '2',
};

/** Circle USDC on Base Sepolia (its EIP-712 name differs from mainnet's). */
export const USDC_BASE_SEPOLIA: PaymentAsset = {
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  symbol: 'USDC',
  decimals: 6,
  name: 'USDC',
  version: '2',
};

/** Canonical Uniswap Permit2 (same address on every EVM chain). */
export const PERMIT2_ADDRESS: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
/** x402ExactPermit2Proxy — the Permit2 spender payers sign for in the `exact` scheme. */
export const X402_EXACT_PERMIT2_PROXY: Address = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';

/** Preset ids, in `PRESET_NETWORKS` order. */
export const PRESET_NAMES = ['radius', 'radius-testnet', 'base', 'base-sepolia'] as const;
/** A preset id proper (no aliases). */
export type PresetName = (typeof PRESET_NAMES)[number];
/** Alternative names for presets: `mainnet` / `testnet` are Radius mainnet / testnet. */
export const NETWORK_ALIASES = { mainnet: 'radius', testnet: 'radius-testnet' } as const satisfies Record<string, PresetName>;
/** Preset ids, aliases included. */
export type NetworkName = PresetName | keyof typeof NETWORK_ALIASES;

/** Any EVM chain that can carry x402 payments. */
export interface PaymentNetworkConfig {
  chain: Chain;
  asset: PaymentAsset;
  /** Label for messages; defaults to the chain name. */
  name?: string;
  /** Default facilitator for sellers (see `PaymentNetwork.facilitatorUrl`). */
  facilitatorUrl?: string;
  /** Override the chain's default RPC. */
  rpcUrl?: string;
  /** Override the chain's explorer. */
  explorerUrl?: string;
  faucetUrl?: string;
  /** Radius semantics (see `PaymentNetwork.radius`). Default false. */
  radius?: boolean;
  /** x402 v1 network names (see `PaymentNetwork.v1Names`). */
  v1Names?: readonly string[];
  /** The preset in the other tier (see `PaymentNetwork.counterpart`). */
  counterpart?: PresetName;
}

/** Anything `resolveNetwork` understands. Defaults to Radius mainnet when omitted. */
export type NetworkInput = NetworkName | PaymentNetwork | PaymentNetworkConfig;

export interface NetworkOverrides {
  rpcUrl?: string;
  facilitatorUrl?: string;
  explorerUrl?: string;
  faucetUrl?: string;
  /** Override the payment asset (e.g. a different token on the same chain). */
  asset?: Partial<PaymentAsset>;
}

/** The override fields of an options object, or undefined when none is set (so presets stay identical). */
export function overridesOf(options: NetworkOverrides): NetworkOverrides | undefined {
  const { rpcUrl, facilitatorUrl, explorerUrl, faucetUrl, asset } = options;
  if (rpcUrl === undefined && facilitatorUrl === undefined && explorerUrl === undefined && faucetUrl === undefined && asset === undefined) return undefined;
  return { rpcUrl, facilitatorUrl, explorerUrl, faucetUrl, asset };
}

/** Build a network from a viem chain and its payment asset. */
export function definePaymentNetwork(config: PaymentNetworkConfig): PaymentNetwork {
  if (!config.chain || !Number.isInteger(config.chain.id)) throw new Error('definePaymentNetwork: chain must be a viem Chain');
  if (!config.asset?.address) throw new Error('definePaymentNetwork: asset is required');
  return fromChain(withChainOverrides(config.chain, config), {
    name: config.name,
    facilitatorUrl: config.facilitatorUrl ? stripTrailingSlash(config.facilitatorUrl) : undefined,
    faucetUrl: config.faucetUrl,
    asset: config.asset,
    radius: config.radius ?? false,
    v1Names: config.v1Names ?? [],
    counterpart: config.counterpart,
  });
}

export const radiusMainnet: PaymentNetwork = definePaymentNetwork({
  chain: radiusMainnetChain,
  name: 'radius',
  facilitatorUrl: 'https://facilitator.radiustech.xyz',
  faucetUrl: 'https://network.radiustech.xyz/api/v1/faucet',
  asset: SBC,
  radius: true,
  counterpart: 'radius-testnet',
});

export const radiusTestnet: PaymentNetwork = definePaymentNetwork({
  chain: radiusTestnetChain,
  name: 'radius-testnet',
  facilitatorUrl: 'https://facilitator.testnet.radiustech.xyz',
  faucetUrl: 'https://testnet.radiustech.xyz/api/v1/faucet',
  asset: SBC,
  radius: true,
  counterpart: 'radius',
});

export const baseMainnet: PaymentNetwork = definePaymentNetwork({
  chain: baseChain,
  name: 'base',
  facilitatorUrl: 'https://facilitator.radiustech.xyz',
  asset: USDC_BASE,
  v1Names: ['base'],
  counterpart: 'base-sepolia',
});

export const baseSepolia: PaymentNetwork = definePaymentNetwork({
  chain: baseSepoliaChain,
  name: 'base-sepolia',
  facilitatorUrl: 'https://facilitator.testnet.radiustech.xyz',
  asset: USDC_BASE_SEPOLIA,
  v1Names: ['base-sepolia'],
  counterpart: 'base',
});

/** Every preset, Radius first (the order of `PRESET_NAMES`). */
export const PRESET_NETWORKS: readonly PaymentNetwork[] = [radiusMainnet, radiusTestnet, baseMainnet, baseSepolia];

const PRESETS_BY_NAME = presetsByName();

/** Every preset id, aliases included. */
export const NETWORK_NAMES = Object.keys(PRESETS_BY_NAME) as readonly NetworkName[];

/** Index the presets by id and alias; a preset list that disagrees with `PRESET_NAMES` is a programming error. */
function presetsByName(): Record<NetworkName, PaymentNetwork> {
  const byName: Partial<Record<NetworkName, PaymentNetwork>> = {};
  for (const preset of PRESET_NETWORKS) {
    if (!PRESET_NAMES.includes(preset.name as PresetName)) throw new Error(`radius-sdk: preset '${preset.name}' is missing from PRESET_NAMES`);
    byName[preset.name as PresetName] = preset;
  }
  for (const name of PRESET_NAMES) if (!byName[name]) throw new Error(`radius-sdk: PRESET_NAMES names '${name}', which is not in PRESET_NETWORKS`);
  for (const [alias, name] of Object.entries(NETWORK_ALIASES)) byName[alias as NetworkName] = byName[name];
  return byName as Record<NetworkName, PaymentNetwork>;
}

/** The preset in the other tier (mainnet ↔ testnet) of a preset, or undefined for a custom network. */
export function counterpartOf(network: PaymentNetwork): PaymentNetwork | undefined {
  return network.counterpart ? PRESETS_BY_NAME[network.counterpart] : undefined;
}

function isPaymentNetwork(v: unknown): v is PaymentNetwork {
  return typeof v === 'object' && v !== null && 'chain' in v && 'network' in v && 'asset' in v && 'v1Names' in v;
}

/**
 * Resolve a network from a preset id, a network, or a config, applying overrides.
 * Defaults to Radius mainnet.
 */
export function resolveNetwork(input?: NetworkInput, overrides?: NetworkOverrides): PaymentNetwork {
  let base: PaymentNetwork;
  if (input === undefined) base = radiusMainnet;
  else if (typeof input === 'string') {
    if (!Object.hasOwn(PRESETS_BY_NAME, input)) {
      throw new Error(`resolveNetwork: unknown network '${input}' (expected one of ${Object.keys(PRESETS_BY_NAME).join(', ')}, or a network object)`);
    }
    base = PRESETS_BY_NAME[input];
  } else if (isPaymentNetwork(input)) base = input;
  else if (typeof input === 'object' && input !== null) base = definePaymentNetwork(input);
  else throw new Error(`resolveNetwork: unknown network '${String(input)}'`);

  // A spread-and-edited preset (`{ ...radiusTestnet, rpcUrl }`) leaves `chain` stale;
  // treat convenience fields that disagree with the chain as overrides of it.
  const rpcUrl = overrides?.rpcUrl ?? (base.rpcUrl !== rpcUrlOf(base.chain) ? base.rpcUrl : undefined);
  const explorerUrl = overrides?.explorerUrl ?? (base.explorerUrl !== explorerUrlOf(base.chain) ? base.explorerUrl : undefined);
  if (!overrides && !rpcUrl && !explorerUrl) return base;
  return fromChain(withChainOverrides(base.chain, { rpcUrl, explorerUrl }), {
    name: base.name,
    facilitatorUrl: overrides?.facilitatorUrl ? stripTrailingSlash(overrides.facilitatorUrl) : base.facilitatorUrl,
    faucetUrl: overrides?.faucetUrl ?? base.faucetUrl,
    asset: overrides?.asset ? { ...base.asset, ...overrides.asset } : base.asset,
    radius: base.radius,
    v1Names: base.v1Names,
    counterpart: base.counterpart,
  });
}

/** The preset whose chain id matches, if any. */
export function presetForChainId(chainId: number | undefined): PaymentNetwork | undefined {
  return PRESET_NETWORKS.find((n) => n.chainId === chainId);
}

/** True when `id` (CAIP-2, or an x402 v1 name) names `network`. */
export function isNetworkId(network: PaymentNetwork, id: string): boolean {
  return id === network.network || network.v1Names.includes(id);
}

/** Parse a CAIP-2 `eip155:<id>` string to a chain id, or undefined. */
export function chainIdFromCaip2(network: string): number | undefined {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) return undefined;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}

/** Explorer link for a settlement transaction, e.g. https://testnet.radiustech.xyz/tx/0x… */
export function explorerTxUrl(network: PaymentNetwork, txHash: string): string | undefined {
  return network.explorerUrl ? `${network.explorerUrl}/tx/${txHash}` : undefined;
}

/** Assemble a PaymentNetwork whose convenience fields are derived from `chain`. */
function fromChain(
  chain: Chain,
  rest: { name?: string; facilitatorUrl?: string; faucetUrl?: string; asset: PaymentAsset; radius: boolean; v1Names: readonly string[]; counterpart?: PresetName },
): PaymentNetwork {
  return {
    name: rest.name ?? chain.name,
    chain,
    chainId: chain.id,
    network: `eip155:${chain.id}`,
    rpcUrl: rpcUrlOf(chain),
    facilitatorUrl: rest.facilitatorUrl,
    explorerUrl: explorerUrlOf(chain),
    faucetUrl: rest.faucetUrl,
    asset: rest.asset,
    testnet: chain.testnet ?? false,
    radius: rest.radius,
    v1Names: rest.v1Names,
    ...(rest.counterpart ? { counterpart: rest.counterpart } : {}),
  };
}

/** Return `chain` with its default RPC / explorer replaced (a new chain; the input is untouched). */
function withChainOverrides(chain: Chain, o: { rpcUrl?: string; explorerUrl?: string }): Chain {
  if (!o.rpcUrl && !o.explorerUrl) return chain;
  const explorerName = chain.blockExplorers?.default.name ?? 'Explorer';
  return {
    ...chain,
    rpcUrls: o.rpcUrl ? { ...chain.rpcUrls, default: { ...chain.rpcUrls.default, http: [stripTrailingSlash(o.rpcUrl)] } } : chain.rpcUrls,
    blockExplorers: o.explorerUrl
      ? { ...chain.blockExplorers, default: { name: explorerName, url: stripTrailingSlash(o.explorerUrl) } }
      : chain.blockExplorers,
  };
}

function rpcUrlOf(chain: Chain): string {
  const url = chain.rpcUrls.default.http[0];
  if (!url) throw new Error(`Chain ${chain.id} (${chain.name}) declares no default HTTP RPC URL`);
  return url;
}

function explorerUrlOf(chain: Chain): string | undefined {
  return chain.blockExplorers?.default.url;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
