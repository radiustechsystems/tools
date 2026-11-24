/**
 * Token arguments and balance reads for the wallet commands, on top of `radius-sdk/client`.
 * A token argument is either the symbol `SBC` (the configured SBC contract, 6 decimals known up
 * front) or any 0x address, whose decimals and symbol the SDK reads on-chain when needed.
 */
import { formatUnits, isAddress, type Address } from 'viem';
import { getBalance } from 'viem/actions';
import { resolveNetwork, SBC, type PaymentNetwork } from 'radius-sdk';
import type { BalanceClient, BalanceToken, TokenAmount, TokenInput } from 'radius-sdk/client';
import { getBalances, getAggregateBalance, getTokenBalance } from 'radius-sdk/client';
import { formatUsd } from './format.js';
import type { ResolvedConfig } from '../types.js';

/** The configured SBC contract as a balance/ERC-20 token: `--sbc` / `RADIUS_SBC_ADDRESS`, else the canonical address. */
export function sbcToken(cfg: ResolvedConfig): BalanceToken {
  return { address: cfg.sbcAddress ?? SBC.address, symbol: SBC.symbol, decimals: SBC.decimals, convertible: true };
}

/** `SBC` (any case) or a 0x token address. */
export function parseTokenArg(cfg: ResolvedConfig, arg: string): TokenInput {
  const trimmed = arg.trim();
  if (trimmed.toUpperCase() === 'SBC') return sbcToken(cfg);
  if (isAddress(trimmed)) return trimmed as Address;
  throw new Error(`Token must be SBC or a 0x contract address, got: ${arg}`);
}

/** A display amount like `1.5`, parsed with the token's decimals by the SDK. */
export function parseAmountArg(arg: string): TokenAmount {
  const trimmed = arg.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Amount must be a decimal number like 1.5, got: ${arg}`);
  return trimmed;
}

export interface BalanceReport {
  address: Address;
  /** The preset the balances were read on. */
  network: string;
  /** The network's payment asset (SBC on Radius, USDC on Base, OUSD on Tempo), in display units. */
  asset: { symbol: string; address: Address; formatted: string; atomic: string; error: string | null };
  /**
   * The chain's native coin, or null where it has none (Tempo). On Radius, native RUSD only
   * (what the EVM `BALANCE` opcode sees), with `aggregateWei` being what `eth_getBalance`
   * reports: native plus convertible SBC. Elsewhere `wei` and `aggregateWei` are the same read.
   */
  native: { symbol: string; formatted: string; wei: string; aggregateWei: string; source: 'evm' | 'derived' | 'aggregate' } | null;
  /** What the account can spend in USD: native RUSD plus SBC on Radius, the asset alone elsewhere. */
  totalUsd: number;
}

/**
 * The network's asset and native balances kept apart. On Radius `eth_getBalance` already counts
 * SBC 1:1, so the SDK's `getBalances` is what keeps the total from double counting; if the SBC
 * read fails the aggregate is reported as RUSD, as `eth_getBalance` would, with the error
 * attached. On other chains the asset is a plain ERC-20 read and the native coin a plain
 * `eth_getBalance`, left out on a chain without one.
 */
export async function readBalances(client: BalanceClient, cfg: ResolvedConfig, address: Address): Promise<BalanceReport> {
  // `--sbc` names the SBC contract on Radius; other networks keep their own asset.
  const network = resolveNetwork(cfg.network, { rpcUrl: cfg.rpcUrl });
  if (network.radius) return readRadiusBalances(client, cfg, network, address);
  const { symbol, decimals } = network.asset;
  const token: BalanceToken = { address: network.asset.address, symbol, decimals, convertible: false };
  const [asset, wei] = await Promise.all([
    getTokenBalance(client, { address, token }).then(
      (t) => ({ symbol, address: token.address, formatted: t.formatted, atomic: t.atomic.toString(), error: null }),
      (e: unknown) => ({ symbol, address: token.address, formatted: '0', atomic: '0', error: e instanceof Error ? e.message : String(e) }),
    ),
    network.nativeBalance ? getBalance(client, { address }) : Promise.resolve(null),
  ]);
  const native =
    wei === null
      ? null
      : { symbol: network.chain.nativeCurrency.symbol, formatted: formatUnits(wei, network.chain.nativeCurrency.decimals), wei: wei.toString(), aggregateWei: wei.toString(), source: 'aggregate' as const };
  return { address, network: network.name, asset, native, totalUsd: Number(asset.formatted) };
}

async function readRadiusBalances(client: BalanceClient, cfg: ResolvedConfig, network: PaymentNetwork, address: Address): Promise<BalanceReport> {
  const token = sbcToken(cfg);
  const symbol = network.chain.nativeCurrency.symbol;
  try {
    const { native, tokens, totalFormatted } = await getBalances(client, { address, tokens: [token] });
    const sbc = tokens[0];
    return {
      address,
      network: network.name,
      asset: { symbol: sbc.symbol, address: token.address, formatted: sbc.formatted, atomic: sbc.atomic.toString(), error: null },
      native: { symbol, formatted: native.rawFormatted, wei: native.raw.toString(), aggregateWei: native.aggregate.toString(), source: native.rawSource },
      totalUsd: Number(totalFormatted),
    };
  } catch (e) {
    const aggregate = await getAggregateBalance(client, { address });
    const rusd = formatUnits(aggregate, cfg.chain.nativeCurrency.decimals);
    return {
      address,
      network: network.name,
      asset: { symbol: token.symbol, address: token.address, formatted: '0', atomic: '0', error: e instanceof Error ? e.message : String(e) },
      native: { symbol, formatted: rusd, wei: aggregate.toString(), aggregateWei: aggregate.toString(), source: 'aggregate' },
      totalUsd: Number(rusd),
    };
  }
}

/** One line per asset, the native coin's left out on a chain without one. */
export function formatBalanceLines(report: BalanceReport): string[] {
  // Only the first line of the error: viem's are multi-line (URL, request body) and would break the one-line-per-asset layout.
  const asset = report.asset.error ? `unavailable (${report.asset.error.split('\n')[0]})` : `${formatUsd(report.asset.formatted)} ${report.asset.symbol}`;
  // Labels end in a colon and pad to the longest, so the amounts line up.
  const width = Math.max(report.asset.symbol.length, report.native?.symbol.length ?? 0, 'Total'.length) + 1;
  const label = (name: string) => `${name}:`.padEnd(width);
  return [
    `Address: ${report.address}`,
    `${label(report.asset.symbol)} ${asset}`,
    ...(report.native ? [`${label(report.native.symbol)} ${formatUsd(report.native.formatted)} ${report.native.symbol}`] : []),
    `${label('Total')} ${formatUsd(report.totalUsd)} USD`,
  ];
}
