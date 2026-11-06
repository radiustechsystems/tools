import type { Address, Chain, PublicClient, WalletClient } from 'viem';

export type NetworkName = 'mainnet' | 'testnet';

/** Where the account comes from: the local keystore (default) or a wallet proxy (`RADIUS_WALLET=proxy`). */
export type WalletProvider = 'keystore' | 'proxy';

export interface ResolvedConfig {
  network: NetworkName;
  chain: Chain;
  rpcUrl: string;
  sbcAddress?: Address;
  rusdAddress?: Address;
  keystorePath: string;
  password?: string;
  wallet: WalletProvider;
}

export interface GlobalOptions {
  network?: string;
  rpcUrl?: string;
  privateKey?: string;
  sbc?: string;
  rusd?: string;
  json?: boolean;
  wait?: boolean;
}

export interface Clients {
  publicClient: PublicClient;
  walletClient?: WalletClient;
}
