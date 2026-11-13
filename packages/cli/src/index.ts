#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { registerCall } from './commands/call.js';
import { registerCode } from './commands/code.js';
import { registerNetwork } from './commands/network.js';
import { registerNonce } from './commands/nonce.js';
import { registerReceipt } from './commands/receipt.js';
import { registerSell } from './commands/sell.js';
import { registerStorage } from './commands/storage.js';
import { registerTx } from './commands/tx.js';
import { registerWallet } from './commands/wallet.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('radius-cli')
  .description('CLI wallet for the Radius network — like cast, with a built-in account')
  .version(version)
  .option('--network <name>', "'mainnet' or 'testnet' (default: mainnet)")
  .option('--rpc-url <url>', 'override the RPC URL')
  .option('--private-key <hex>', 'sign with this key instead of the local keystore')
  .option('--password-file <path>', 'read the keystore password from this file (one trailing newline is ignored); else RADIUS_PASSWORD, else a prompt on a terminal')
  .option('--sbc <address>', 'override the SBC token contract address')
  .option('--rusd <address>', 'override the RUSD ERC-20 contract address')
  .option('--json', 'machine-readable JSON output');

registerWallet(program);
registerCall(program);
registerTx(program);
registerReceipt(program);
registerStorage(program);
registerCode(program);
registerNonce(program);
registerNetwork(program);
registerSell(program);

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
