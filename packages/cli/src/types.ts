import type { Address, Chain, PublicClient, WalletClient } from 'viem';

export type NetworkName = 'mainnet' | 'testnet';

export interface ResolvedConfig {
  network: NetworkName;
  chain: Chain;
  rpcUrl: string;
  sbcAddress?: Address;
  rusdAddress?: Address;
  keystorePath: string;
  password?: string;
}

export interface GlobalOptions {
  network?: string;
  rpcUrl?: string;
  privateKey?: string;
  /** File holding the keystore password (`--password-file`). */
  passwordFile?: string;
  sbc?: string;
  rusd?: string;
  json?: boolean;
  wait?: boolean;
}

export interface Clients {
  publicClient: PublicClient;
  walletClient?: WalletClient;
}
