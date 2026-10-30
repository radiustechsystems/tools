import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerSell } from '../src/commands/sell.js';

// `sell check` documents exit 2 for bad flags. Every case here fails before any request is made, so
// the URL is never contacted.

class Exit extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

async function run(...args: string[]): Promise<{ code: number; stderr: string }> {
  const program = new Command().option('--network <name>').option('--rpc-url <url>').option('--private-key <hex>').option('--password-file <path>').option('--sbc <address>').option('--rusd <address>').option('--json');
  registerSell(program);
  let stderr = '';
  const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code ?? 0); }) as never);
  try {
    await program.parseAsync(['node', 'radius-cli', ...args]);
    throw new Error('sell check did not exit');
  } catch (e) {
    if (e instanceof Exit) return { code: e.code, stderr };
    throw e;
  } finally {
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
    ['no URL and no --pricing', ['sell', 'check'], /missing <url> \(or --pricing/],
    ['a URL and --pricing', ['sell', 'check', url, '--pricing', 'pricing.md'], /either a <url> or --pricing, not both/],
    ['--price with --pricing', ['sell', 'check', '--pricing', 'pricing.md', '--price', '$0.001'], /each route is checked against its own Price/],
    ['-X with --pricing', ['sell', 'check', '--pricing', 'pricing.md', '-X', 'post'], /-X does not apply with --pricing/],
    ['--pay with --pricing', ['sell', 'check', '--pricing', 'pricing.md', '--pay', '--threshold', '0.01'], /--pay does not apply with --pricing/],
    ['--base-url without --pricing', ['sell', 'check', url, '--base-url', 'http://x'], /--base-url only applies with --pricing/],
    ['--param without --pricing', ['sell', 'check', url, '--param', 'a=b'], /--param only applies with --pricing/],
    ['a --param without =', ['sell', 'check', '--pricing', 'pricing.md', '--param', 'address'], /--param expects name=value/],
    ['a bad --base-url', ['sell', 'check', '--pricing', 'pricing.md', '--base-url', 'localhost:8788'], /--base-url must be an http\(s\) URL/],
    ['an unreadable --pricing file', ['sell', 'check', '--pricing', '/nonexistent/pricing.md', '--base-url', 'http://127.0.0.1:9'], /--pricing \/nonexistent\/pricing.md: ENOENT/],
    ['a negative --free-requests', ['sell', 'check', url, '--free-requests', '-1'], /--free-requests must be an integer from 0 to 1000/],
    ['a huge --free-requests', ['sell', 'check', url, '--free-requests', '5000'], /--free-requests must be an integer/],
    ['an unreadable --password-file', ['--password-file', '/nonexistent/pw', 'sell', 'check', url], /--password-file: cannot read \/nonexistent\/pw \(ENOENT\)/],
  ])('exits 2 for %s', async (_name, args, message) => {
    const { code, stderr } = await run(...args);
    expect(code).toBe(2);
    expect(stderr).toMatch(message);
  });
});
