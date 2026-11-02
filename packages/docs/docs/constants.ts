// Shared constants for Radius documentation
// Import these in any MDX file: import { RPC_URL, CHAIN_ID } from '../constants'

// Network
export const MAINNET_DASHBOARD_URL = 'https://network.radiustech.xyz';
export const MAINNET_RPC_URL = 'https://rpc.radiustech.xyz';
export const MAINNET_CHAIN_ID = 723487;
export const MAINNET_NAME = 'Radius Network';

export const TESTNET_DASHBOARD_URL = 'https://testnet.radiustech.xyz';
export const TESTNET_RPC_URL = 'https://rpc.testnet.radiustech.xyz';
export const TESTNET_CHAIN_ID = 72344;
export const TESTNET_NAME = 'Radius Testnet';

export const NATIVE_TOKEN = 'RUSD';
export const STABLECOIN = 'SBC';
export const CURRENCY_SYMBOL = 'USD';
export const STABLECOIN_DECIMALS = 6;
export const NATIVE_TOKEN_DECIMALS = 18;

// URLs
// Radius Merchant Console, the main call to action of the site banner and /merchant-console
export const MERCHANT_CONSOLE_URL = 'https://app.radiustech.xyz?tabs=1';
export const FAUCET_DASHBOARD_PATH = '/wallet';
export const FAUCET_TESTNET_API_URL = 'https://testnet.radiustech.xyz/api/v1/faucet';

// Transaction cost API (live network data)
export const TRANSACTION_COST_API_PATH = '/api/v1/network/transaction-cost';

// Contracts
export const FEE_CONTRACT = '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb';
export const SBC_CONTRACT = '0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb';

// x402 facilitators (Radius-operated)
export const RADIUS_FACILITATOR_MAINNET_URL = 'https://facilitator.radiustech.xyz';
export const RADIUS_FACILITATOR_TESTNET_URL = 'https://facilitator.testnet.radiustech.xyz';

// CAIP-2 network identifiers (used in x402 config and facilitator discovery)
export const MAINNET_CAIP2 = 'eip155:723487';
export const TESTNET_CAIP2 = 'eip155:72344';

// x402 contracts (canonical, same address on all EVM chains via CREATE2)
export const X402_PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';

// Fees & performance — values updated at build-time by scripts/fetch-transaction-cost.ts
// @tx-cost-start
export const TX_FEE = '0.00010 USD';
export const GAS_PRICE = '9.85998816e-10';
export const GAS_USED = 101444;
// @tx-cost-end

export const HARDFORK = 'Prague';
