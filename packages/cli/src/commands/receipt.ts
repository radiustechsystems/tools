import { Command } from 'commander';
import type { Hash } from 'viem';
import { resolveConfig } from '../lib/config.js';
import { makePublicClient } from '../lib/client.js';
import { decodeLogs, isDecoded, parseEventSignature } from '../lib/events.js';
import { jsonStringify } from '../lib/format.js';
import type { GlobalOptions } from '../types.js';

function assertHash(s: string): asserts s is Hash {
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error(`Not a valid 32-byte hash: ${s}`);
  }
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function formatValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  return jsonStringify(value, 0);
}

export function registerReceipt(program: Command): void {
  program
    .command('receipt')
    .description('Get a transaction receipt by hash')
    .argument('<hash>', 'transaction hash')
    .option(
      '--event <sig>',
      'decode logs matching a cast-style event signature, e.g. "Transfer(address indexed from, address indexed to, uint256 value)" (repeatable)',
      collect,
    )
    .action(async (hash: string, subOpts: { event?: string[] }, cmd) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const cfg = resolveConfig(opts);
      assertHash(hash);
      // Parse before the RPC call so a malformed signature fails fast.
      const events = (subOpts.event ?? []).map(parseEventSignature);
      const client = makePublicClient(cfg);
      const receipt = await client.getTransactionReceipt({ hash });

      if (events.length > 0) {
        const { logs, warnings } = decodeLogs(receipt.logs, events);
        for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
        if (opts.json) {
          console.log(jsonStringify(logs));
          return;
        }
        for (const entry of logs) {
          if (isDecoded(entry)) {
            console.log(`Log ${entry.logIndex ?? '?'}  ${entry.address}  ${entry.eventName}`);
            const width = Math.max(0, ...Object.keys(entry.args).map((k) => k.length)) + 1;
            for (const [name, value] of Object.entries(entry.args)) {
              console.log(`  ${`${name}:`.padEnd(width)} ${formatValue(value)}`);
            }
          } else {
            console.log(`Log ${entry.logIndex ?? '?'}  ${entry.address}  (no matching event)`);
            entry.topics.forEach((topic, i) => console.log(`  topic${i}: ${topic}`));
            console.log(`  data:   ${entry.data}`);
          }
        }
        return;
      }

      if (opts.json) {
        console.log(jsonStringify(receipt));
        return;
      }
      console.log(`Hash:             ${receipt.transactionHash}`);
      console.log(`Status:           ${receipt.status}`);
      console.log(`Block:            ${receipt.blockNumber.toString()}`);
      console.log(`From:             ${receipt.from}`);
      console.log(`To:               ${receipt.to ?? '(contract creation)'}`);
      if (receipt.contractAddress) {
        console.log(`Contract:         ${receipt.contractAddress}`);
      }
      console.log(`Gas used:         ${receipt.gasUsed.toString()}`);
      console.log(`Cumulative gas:   ${receipt.cumulativeGasUsed.toString()}`);
      console.log(`Logs:             ${receipt.logs.length}`);
    });
}
