import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerSell } from '../src/commands/sell.js';

// `sell check` documents exit 2 for bad flags. Every case here fails before any request is made, so
// the URL is never contacted.

async function run(...args: string[]): Promise<{ code: number; stderr: string }> {
  const program = new Command().option('--network <name>').option('--rpc-url <url>').option('--private-key <hex>').option('--sbc <address>').option('--rusd <address>').option('--json');
  registerSell(program);
  let stderr = '';
  const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
  // The command sets process.exitCode rather than calling process.exit(), so piped stdout drains.
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('sell check called process.exit()'); }) as never);
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'radius-cli', ...args]);
    if (process.exitCode === undefined) throw new Error('sell check did not set an exit code');
    return { code: Number(process.exitCode), stderr };
  } finally {
    process.exitCode = undefined;
    write.mockRestore();
    exit.mockRestore();
  }
}

describe('sell check flag validation', () => {
  beforeEach(() => { vi.stubGlobal('fetch', () => { throw new Error('no request expected'); }); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const url = 'http://127.0.0.1:9/api/report';

  it.each([
    ['a header without a colon', ['sell', 'check', url, '-H', 'bad'], /-H expects 'Key: Value'/],
    ['an unreadable body file', ['sell', 'check', url, '-d', '@/nonexistent/body.json'], /ENOENT/],
    ['an unknown --network', ['--network', 'foo', 'sell', 'check', url], /--network must be/],
    ['an unknown --networks', ['sell', 'check', url, '--pay', '--threshold', '0.01', '--networks', 'foo'], /unknown network 'foo'/],
    ['a non-numeric --threshold', ['sell', 'check', url, '--pay', '--threshold', 'abc'], /--threshold must be a decimal/],
    ['a negative --threshold', ['sell', 'check', url, '--pay', '--threshold', '-1'], /--threshold must be a decimal/],
    ['--threshold without --pay', ['sell', 'check', url, '--threshold', '0.01'], /only applies with --pay/],
    ['--pay without --threshold', ['sell', 'check', url, '--pay'], /--pay needs --threshold/],
    ['a bad --price', ['sell', 'check', url, '--price', 'cheap'], /--price must be a USD amount/],
    ['a bad --timeout', ['sell', 'check', url, '--timeout', '0'], /--timeout must be a positive integer/],
    ['a bad URL', ['sell', 'check', 'not a url'], /not a URL/],
  ])('exits 2 for %s', async (_name, args, message) => {
    const { code, stderr } = await run(...args);
    expect(code).toBe(2);
    expect(stderr).toMatch(message);
  });
});
