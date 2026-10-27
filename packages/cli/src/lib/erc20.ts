/**
 * Token arguments and balance reads for the wallet commands, on top of `radius-sdk/client`.
 * A token argument is either the symbol `SBC` (the configured SBC contract, 6 decimals known up
 * front) or any 0x address, whose decimals and symbol the SDK reads on-chain when needed.
 */
import { formatUnits, isAddress, type Address } from 'viem';
import { SBC } from 'radius-sdk';
import type { BalanceClient, BalanceToken, TokenAmount, TokenInput } from 'radius-sdk/client';
import { getBalances, getAggregateBalance } from 'radius-sdk/client';
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
  /** Native RUSD plus SBC at face value, in display units (what the account can spend). */
  totalUsd: number;
  /** SBC only, display units. */
  sbc: string;
  /** Native RUSD only (what the EVM `BALANCE` opcode sees), display units. */
  rusd: string;
  sbcWei: string;
  rusdWei: string;
  /** What `eth_getBalance` reports: native RUSD plus convertible SBC, in wei. */
  aggregateWei: string;
  /** How the native RUSD figure was obtained: `evm` (read via init code), `derived` (aggregate minus SBC), or `aggregate` when the SBC read failed. */
  rusdSource: 'evm' | 'derived' | 'aggregate';
  sbcError: string | null;
}

/**
 * Native and SBC balances kept apart. On Radius `eth_getBalance` already counts SBC 1:1, so the
 * SDK's `getBalances` is what keeps the total from double counting. If the SBC read fails the
 * aggregate is reported as RUSD, as `eth_getBalance` would, with the error attached.
 */
export async function readBalances(client: BalanceClient, cfg: ResolvedConfig, address: Address): Promise<BalanceReport> {
  const token = sbcToken(cfg);
  try {
    const { native, tokens, totalFormatted } = await getBalances(client, { address, tokens: [token] });
    const sbc = tokens[0];
    return {
      address,
      totalUsd: Number(totalFormatted),
      sbc: sbc.formatted,
      rusd: native.rawFormatted,
      sbcWei: sbc.atomic.toString(),
      rusdWei: native.raw.toString(),
      aggregateWei: native.aggregate.toString(),
      rusdSource: native.rawSource,
      sbcError: null,
    };
  } catch (e) {
    const aggregate = await getAggregateBalance(client, { address });
    const rusd = formatUnits(aggregate, cfg.chain.nativeCurrency.decimals);
    return {
      address,
      totalUsd: Number(rusd),
      sbc: '0',
      rusd,
      sbcWei: '0',
      rusdWei: aggregate.toString(),
      aggregateWei: aggregate.toString(),
      rusdSource: 'aggregate',
      sbcError: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Human `wallet balance` output: one `label: value` line per asset and the total, so each is greppable. */
export function formatBalanceLines(report: BalanceReport): string[] {
  const sbc = report.sbcError ? `unavailable (${report.sbcError})` : formatUsd(report.sbc);
  return [
    `Address: ${report.address}`,
    `SBC:     ${sbc}`,
    `RUSD:    ${formatUsd(report.rusd)}`,
    `Total:   ${formatUsd(report.totalUsd)} USD`,
  ];
}
