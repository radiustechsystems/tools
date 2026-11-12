import { defineChain } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  baseChain,
  baseMainnet,
  baseSepolia,
  baseSepoliaChain,
  counterpartOf,
  definePaymentNetwork,
  isNetworkId,
  NETWORK_ALIASES,
  NETWORK_NAMES,
  PRESET_NAMES,
  PRESET_NETWORKS,
  presetForChainId,
  radiusMainnet,
  radiusMainnetChain,
  radiusTestnet,
  radiusTestnetChain,
  resolveNetwork,
  SBC,
  USDC_BASE,
  USDC_BASE_SEPOLIA,
} from '../src/networks.js';

describe('viem chains', () => {
  it('describe mainnet and testnet', () => {
    expect(radiusMainnetChain).toMatchObject({
      id: 723487,
      name: 'Radius Network',
      nativeCurrency: { name: 'Radius USD', symbol: 'RUSD', decimals: 18 },
      rpcUrls: { default: { http: ['https://rpc.radiustech.xyz'] } },
      blockExplorers: { default: { name: 'Radius Network Explorer', url: 'https://network.radiustech.xyz' } },
    });
    expect(radiusMainnetChain.testnet).toBeFalsy();
    expect(radiusTestnetChain).toMatchObject({
      id: 72344,
      name: 'Radius Test Network',
      nativeCurrency: { symbol: 'RUSD', decimals: 18 },
      rpcUrls: { default: { http: ['https://rpc.testnet.radiustech.xyz'] } },
      blockExplorers: { default: { url: 'https://testnet.radiustech.xyz' } },
      testnet: true,
    });
  });

  it('are the source of truth for the presets', () => {
    expect(radiusMainnet.chain).toBe(radiusMainnetChain);
    expect(radiusTestnet.chain).toBe(radiusTestnetChain);
    for (const n of [radiusMainnet, radiusTestnet]) {
      expect(n.chainId).toBe(n.chain.id);
      expect(n.network).toBe(`eip155:${n.chain.id}`);
      expect(n.rpcUrl).toBe(n.chain.rpcUrls.default.http[0]);
      expect(n.explorerUrl).toBe(n.chain.blockExplorers?.default.url);
      expect(n.testnet).toBe(n.chain.testnet ?? false);
    }
    expect(radiusMainnet).toMatchObject({ name: 'radius', chainId: 723487, network: 'eip155:723487', testnet: false, radius: true, facilitatorUrl: 'https://facilitator.radiustech.xyz' });
    expect(radiusTestnet).toMatchObject({ name: 'radius-testnet', chainId: 72344, network: 'eip155:72344', testnet: true, radius: true, facilitatorUrl: 'https://facilitator.testnet.radiustech.xyz' });
  });

  it('describe Base and Base Sepolia, with USDC and no Radius features', () => {
    expect(baseChain).toMatchObject({ id: 8453, nativeCurrency: { symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://mainnet.base.org'] } } });
    expect(baseSepoliaChain).toMatchObject({ id: 84532, testnet: true, rpcUrls: { default: { http: ['https://sepolia.base.org'] } } });
    expect(baseMainnet).toMatchObject({ name: 'base', network: 'eip155:8453', asset: USDC_BASE, radius: false, testnet: false, v1Names: ['base'], facilitatorUrl: 'https://facilitator.radiustech.xyz' });
    expect(baseMainnet.faucetUrl).toBeUndefined();
    expect(baseSepolia).toMatchObject({ name: 'base-sepolia', network: 'eip155:84532', asset: USDC_BASE_SEPOLIA, radius: false, testnet: true, v1Names: ['base-sepolia'], facilitatorUrl: 'https://facilitator.testnet.radiustech.xyz' });
    // The EIP-712 domains differ between the two USDC deployments.
    expect(USDC_BASE).toMatchObject({ address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2', decimals: 6 });
    expect(USDC_BASE_SEPOLIA).toMatchObject({ address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC', version: '2', decimals: 6 });
  });
});

describe('preset lookup', () => {
  it('lists every preset once, with mainnet/testnet counterparts that point back', () => {
    expect(PRESET_NETWORKS.map((n) => n.name)).toEqual(PRESET_NAMES);
    expect(NETWORK_NAMES).toEqual([...PRESET_NAMES, ...Object.keys(NETWORK_ALIASES)]);
    for (const n of PRESET_NETWORKS) {
      const other = counterpartOf(n)!;
      expect(other.testnet).toBe(!n.testnet);
      expect(other.radius).toBe(n.radius);
      expect(counterpartOf(other)).toBe(n);
    }
    expect(counterpartOf(radiusMainnet)).toBe(radiusTestnet);
    expect(counterpartOf(baseSepolia)).toBe(baseMainnet);
    expect(counterpartOf(resolveNetwork('base', { rpcUrl: 'https://base.example' }))).toBe(baseSepolia);
    expect(counterpartOf(definePaymentNetwork({ chain: baseChain, asset: USDC_BASE }))).toBeUndefined();
  });

  it('finds presets by chain id and matches CAIP-2 ids and x402 v1 names', () => {
    expect(presetForChainId(723487)).toBe(radiusMainnet);
    expect(presetForChainId(84532)).toBe(baseSepolia);
    expect(presetForChainId(1)).toBeUndefined();
    expect(isNetworkId(baseMainnet, 'eip155:8453')).toBe(true);
    expect(isNetworkId(baseMainnet, 'base')).toBe(true);
    expect(isNetworkId(baseMainnet, 'base-sepolia')).toBe(false);
    expect(isNetworkId(radiusMainnet, 'radius')).toBe(false);
  });
});

describe('resolveNetwork', () => {
  it('defaults to Radius mainnet', () => {
    expect(resolveNetwork()).toBe(radiusMainnet);
    expect(resolveNetwork('mainnet').network).toBe('eip155:723487');
    expect(resolveNetwork('testnet').network).toBe('eip155:72344');
    expect(resolveNetwork(radiusTestnet)).toBe(radiusTestnet);
  });
  it('resolves preset ids, with mainnet/testnet as Radius aliases', () => {
    expect(resolveNetwork('radius')).toBe(radiusMainnet);
    expect(resolveNetwork('radius-testnet')).toBe(radiusTestnet);
    expect(resolveNetwork('base')).toBe(baseMainnet);
    expect(resolveNetwork('base-sepolia')).toBe(baseSepolia);
    expect(() => resolveNetwork('polygon' as never)).toThrow(/unknown network 'polygon'/);
    expect(() => resolveNetwork('toString' as never)).toThrow(/unknown network/);
  });
  it('keeps Radius and v1 fields through overrides', () => {
    const n = resolveNetwork('base', { rpcUrl: 'https://base.example/KEY' });
    expect(n).toMatchObject({ name: 'base', rpcUrl: 'https://base.example/KEY', radius: false, v1Names: ['base'], asset: USDC_BASE });
    expect(resolveNetwork('testnet', { rpcUrl: 'https://x' }).radius).toBe(true);
  });
  it('applies overrides without mutating presets', () => {
    const n = resolveNetwork('testnet', { rpcUrl: 'https://rpc.testnet.radiustech.xyz/KEY/', asset: { symbol: 'USDX' } });
    expect(n.rpcUrl).toBe('https://rpc.testnet.radiustech.xyz/KEY');
    expect(n.asset.symbol).toBe('USDX');
    expect(n.asset.address).toBe(SBC.address);
    expect(radiusTestnet.asset.symbol).toBe('SBC');
    expect(radiusTestnet.rpcUrl).toBe('https://rpc.testnet.radiustech.xyz');
    expect(radiusTestnetChain.rpcUrls.default.http[0]).toBe('https://rpc.testnet.radiustech.xyz');
  });
  it('carries an rpcUrl override into the chain viem clients are built from', () => {
    const n = resolveNetwork('testnet', { rpcUrl: 'https://rpc.testnet.radiustech.xyz/KEY', explorerUrl: 'https://explorer.example/' });
    expect(n.chain).not.toBe(radiusTestnetChain);
    expect(n.chain.id).toBe(72344);
    expect(n.chain.rpcUrls.default.http).toEqual(['https://rpc.testnet.radiustech.xyz/KEY']);
    expect(n.chain.blockExplorers?.default).toEqual({ name: 'Radius Test Network Explorer', url: 'https://explorer.example' });
    expect(n.explorerUrl).toBe('https://explorer.example');
    expect(n.chain.testnet).toBe(true);
    expect(n.chain.nativeCurrency.symbol).toBe('RUSD');
  });
  it('re-syncs the chain when a preset was spread and edited', () => {
    const n = resolveNetwork({ ...radiusTestnet, rpcUrl: 'https://rpc.testnet.radiustech.xyz/KEY' });
    expect(n.chain.rpcUrls.default.http).toEqual(['https://rpc.testnet.radiustech.xyz/KEY']);
    expect(n.rpcUrl).toBe('https://rpc.testnet.radiustech.xyz/KEY');
    expect(n.chainId).toBe(72344);
  });
});

describe('definePaymentNetwork', () => {
  const asset = { address: '0x1111111111111111111111111111111111111111', symbol: 'TST', decimals: 6, name: 'Test', version: '1' } as const;
  it('builds any EVM network from a viem chain and its asset', () => {
    const chain = defineChain({
      id: 5151,
      name: 'Dev Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['http://dev-rpc'] } },
      blockExplorers: { default: { name: 'Dev Explorer', url: 'http://dev-explorer' } },
      testnet: true,
    });
    const n = definePaymentNetwork({ chain, asset, facilitatorUrl: 'http://fac/' });
    expect(n.chain).toBe(chain);
    expect(n).toMatchObject({ name: 'Dev Chain', chainId: 5151, network: 'eip155:5151', rpcUrl: 'http://dev-rpc', explorerUrl: 'http://dev-explorer', testnet: true, asset, radius: false, v1Names: [], facilitatorUrl: 'http://fac' });
    const overridden = definePaymentNetwork({ chain, asset, name: 'dev', rpcUrl: 'http://other-rpc/', radius: true, v1Names: ['dev'] });
    expect(overridden).toMatchObject({ name: 'dev', rpcUrl: 'http://other-rpc', radius: true, v1Names: ['dev'] });
    expect(overridden.facilitatorUrl).toBeUndefined();
    expect(overridden.chain.rpcUrls.default.http).toEqual(['http://other-rpc']);
    expect(overridden.chain.blockExplorers?.default.name).toBe('Dev Explorer');
    expect(chain.rpcUrls.default.http).toEqual(['http://dev-rpc']);
    expect(resolveNetwork({ chain: radiusMainnetChain, asset: SBC }).network).toBe('eip155:723487');
  });
  it('requires a chain and an asset', () => {
    expect(() => definePaymentNetwork({ chain: undefined as never, asset })).toThrow(/chain/);
    expect(() => definePaymentNetwork({ chain: radiusMainnetChain, asset: undefined as never })).toThrow(/asset/);
  });
});
