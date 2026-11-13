#!/usr/bin/env tsx
/**
 * generate-networks.ts
 *
 * Renders the network tables of the READMEs and reference pages from radius-sdk's presets, so
 * chain ids, assets, RPC endpoints and default facilitators are stated once, in the SDK.
 *
 * Each table sits between marker lines in its file (`<!-- networks:start -->` … `<!-- networks:end -->`
 * in Markdown, `{/* networks:start *\/}` … `{/* networks:end *\/}` in MDX); whatever is between them
 * is replaced. The columns are per file; a table's rows are one per preset.
 *
 * Usage:
 *   pnpm docs:networks            # rewrite the tables
 *   pnpm docs:networks --check    # exit 1 when a table is stale (run by `pnpm lint`)
 *
 * Needs the SDK built (`pnpm --filter radius-sdk build`): `radius-sdk` resolves to its dist/.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { NETWORK_ALIASES, PRESET_NETWORKS, resolveNetwork, type PaymentNetwork } from 'radius-sdk';
import {
  MAINNET_CAIP2,
  MAINNET_CHAIN_ID,
  MAINNET_RPC_URL,
  RADIUS_FACILITATOR_MAINNET_URL,
  RADIUS_FACILITATOR_TESTNET_URL,
  TESTNET_CAIP2,
  TESTNET_CHAIN_ID,
  TESTNET_RPC_URL,
} from '../docs/constants';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname ?? __dirname, '..', '..', '..');

/** The exported constant of each preset: not part of the preset data, so listed here. */
const EXPORT_NAMES: Record<string, string> = {
  radius: 'radiusMainnet',
  'radius-testnet': 'radiusTestnet',
  base: 'baseMainnet',
  'base-sepolia': 'baseSepolia',
};

/** Preset id → alias (`radius` → `mainnet`). */
const ALIAS_OF = new Map<string, string>(Object.entries(NETWORK_ALIASES).map(([alias, name]) => [name, alias]));

/** The preset `resolveNetwork()` picks when none is named. */
const DEFAULT_PRESET = resolveNetwork();

interface NetworkTable {
  /** File path, relative to the repository root. */
  file: string;
  columns: string[];
  /** Presets in the table (default: all). */
  presets?: (network: PaymentNetwork) => boolean;
  row: (network: PaymentNetwork) => string[];
}

const TABLES: NetworkTable[] = [
  {
    file: 'packages/sdk/README.md',
    columns: ['Preset', 'Chain', 'Asset', 'Default facilitator'],
    row: (n) => [presetIds(n), `${n.chain.name}, ${n.chainId}`, n.asset.symbol, facilitatorHost(n)],
  },
  {
    file: 'packages/docs/docs/pages/reference/radius-sdk.mdx',
    columns: ['Network', 'Chain ID', 'Asset', 'Default facilitator', 'Export'],
    row: (n) => [presetIds(n), String(n.chainId), n.asset.symbol, facilitatorHost(n), code(exportName(n))],
  },
  // The CLI's --network takes the aliases (mainnet / testnet): the Radius presets only.
  {
    file: 'packages/cli/README.md',
    columns: ['Network', 'Chain ID', 'Default RPC'],
    presets: (n) => ALIAS_OF.has(n.name),
    row: (n) => [cliNetwork(n), String(n.chainId), code(n.rpcUrl)],
  },
  {
    file: 'packages/docs/docs/pages/reference/radius-cli.mdx',
    columns: ['Network', 'Chain ID', 'Default RPC'],
    presets: (n) => ALIAS_OF.has(n.name),
    row: (n) => [cliNetwork(n), String(n.chainId), code(n.rpcUrl)],
  },
];

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

function code(value: string): string {
  return `\`${value}\``;
}

/** `'mainnet'` / `'radius'` (default) — the ids `resolveNetwork` accepts for a preset. */
function presetIds(n: PaymentNetwork): string {
  const alias = ALIAS_OF.get(n.name);
  const ids = [alias, n.name].filter((id): id is string => id !== undefined).map((id) => code(`'${id}'`));
  return ids.join(' / ') + (n === DEFAULT_PRESET ? ' (default)' : '');
}

/** The CLI's `--network` value for a Radius preset. */
function cliNetwork(n: PaymentNetwork): string {
  const alias = ALIAS_OF.get(n.name);
  if (!alias) throw new Error(`${n.name} has no CLI network name (an alias in NETWORK_ALIASES)`);
  return code(alias) + (n === DEFAULT_PRESET ? ' _(default)_' : '');
}

function facilitatorHost(n: PaymentNetwork): string {
  return n.facilitatorUrl ? new URL(n.facilitatorUrl).host : 'none: sellers name one';
}

function exportName(n: PaymentNetwork): string {
  const name = EXPORT_NAMES[n.name];
  if (!name)
    throw new Error(
      `${n.name}: add its exported constant to EXPORT_NAMES in ${relative(REPO_ROOT, import.meta.filename ?? __filename)}`,
    );
  return name;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A GFM table with padded columns, as Prettier formats one. */
export function renderTable(columns: string[], rows: string[][]): string {
  const widths = columns.map((column, i) => Math.max(3, column.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => `| ${cells.map((cell, i) => cell.padEnd(widths[i])).join(' | ')} |`;
  return [line(columns), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function markers(file: string): { start: string; end: string } {
  const mdx = extname(file) === '.mdx';
  return mdx
    ? { start: '{/* networks:start */}', end: '{/* networks:end */}' }
    : { start: '<!-- networks:start -->', end: '<!-- networks:end -->' };
}

/** `source` with the block between the markers replaced by `table`. */
export function replaceTable(source: string, file: string, table: string): string {
  const { start, end } = markers(file);
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  if (from < 0 || to < 0 || to < from) throw new Error(`${file}: expected '${start}' before '${end}'`);
  return `${source.slice(0, from + start.length)}\n\n${table}\n\n${source.slice(to)}`;
}

function render(table: NetworkTable): { path: string; before: string; after: string } {
  const path = join(REPO_ROOT, table.file);
  const before = readFileSync(path, 'utf8');
  const presets = PRESET_NETWORKS.filter(table.presets ?? (() => true));
  const after = replaceTable(before, table.file, renderTable(table.columns, presets.map(table.row)));
  return { path, before, after };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * `docs/constants.ts`, which the prose uses, must say what the presets the tables come from say.
 * Returns the disagreements.
 */
function constantsDisagreeing(): string[] {
  const radius = resolveNetwork('radius');
  const testnet = resolveNetwork('radius-testnet');
  const expected: [name: string, constant: unknown, preset: unknown][] = [
    ['MAINNET_CHAIN_ID', MAINNET_CHAIN_ID, radius.chainId],
    ['MAINNET_CAIP2', MAINNET_CAIP2, `eip155:${radius.chainId}`],
    ['MAINNET_RPC_URL', MAINNET_RPC_URL, radius.rpcUrl],
    ['RADIUS_FACILITATOR_MAINNET_URL', RADIUS_FACILITATOR_MAINNET_URL, radius.facilitatorUrl],
    ['TESTNET_CHAIN_ID', TESTNET_CHAIN_ID, testnet.chainId],
    ['TESTNET_CAIP2', TESTNET_CAIP2, `eip155:${testnet.chainId}`],
    ['TESTNET_RPC_URL', TESTNET_RPC_URL, testnet.rpcUrl],
    ['RADIUS_FACILITATOR_TESTNET_URL', RADIUS_FACILITATOR_TESTNET_URL, testnet.facilitatorUrl],
  ];
  return expected
    .filter(([, constant, preset]) => constant !== preset)
    .map(([name, constant, preset]) => `${name} is ${String(constant)}; the preset says ${String(preset)}`);
}

function main(): void {
  const check = process.argv.includes('--check');
  const disagreeing = constantsDisagreeing();
  if (disagreeing.length > 0) {
    console.error(`docs/constants.ts disagrees with radius-sdk's presets:\n${disagreeing.map((d) => `  ${d}`).join('\n')}`);
    process.exit(1);
  }
  const stale: string[] = [];
  for (const table of TABLES) {
    const { path, before, after } = render(table);
    if (before === after) continue;
    stale.push(table.file);
    if (!check) writeFileSync(path, after);
  }
  if (check && stale.length > 0) {
    console.error(
      `Network tables are stale in:\n${stale.map((f) => `  ${f}`).join('\n')}\nRun \`pnpm docs:networks\` in packages/docs and commit the result.`,
    );
    process.exit(1);
  }
  console.log(
    check
      ? `Network tables are up to date (${TABLES.length} files).`
      : `Updated ${stale.length} of ${TABLES.length} network tables.`,
  );
}

main();
