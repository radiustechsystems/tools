import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { saveKeystore } from '../src/lib/keystore.js';

// Unlocking the keystore without a terminal (agents, CI): --password-file or RADIUS_PASSWORD, and a
// clear error instead of a prompt nobody can answer. RADIUS_HOME is a temp dir, so the developer's
// own ~/.radius never decides the outcome; modules are imported after it is set.

const PASSWORD = 'correct-horse-battery-staple';
const privateKey = generatePrivateKey();
const real = privateKeyToAccount(privateKey);
let home: string;
let keystorePath: string;
let passwordFile: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'radius-cli-unlock-'));
  keystorePath = join(home, 'keystore.json');
  passwordFile = join(home, 'pw');
  writeFileSync(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
  await saveKeystore(keystorePath, privateKey, PASSWORD);
  vi.stubEnv('RADIUS_HOME', home);
  vi.stubEnv('RADIUS_KEYSTORE_PATH', keystorePath);
  vi.stubEnv('RADIUS_PASSWORD', undefined as unknown as string);
  delete process.env.RADIUS_PASSWORD;
  vi.resetModules();
}, 20_000);
afterAll(() => { vi.unstubAllEnvs(); });

async function modules() {
  const config = await import('../src/lib/config.js');
  const account = await import('../src/lib/account.js');
  return { ...config, ...account };
}

describe('non-interactive keystore unlock', () => {
  it('reads --password-file without its trailing newline, and it beats RADIUS_PASSWORD', async () => {
    const { resolveConfig, readPasswordFile } = await modules();
    expect(readPasswordFile(passwordFile)).toBe(PASSWORD);
    writeFileSync(join(home, 'pw2'), 'two\n\n');
    expect(readPasswordFile(join(home, 'pw2'))).toBe('two\n');
    vi.stubEnv('RADIUS_PASSWORD', 'from-env');
    try {
      expect(resolveConfig({ passwordFile }).password).toBe(PASSWORD);
      expect(resolveConfig({}).password).toBe('from-env');
    } finally {
      delete process.env.RADIUS_PASSWORD;
    }
    expect(resolveConfig({}).password).toBeUndefined();
  });

  it('names the file, never its contents, when it cannot be read', async () => {
    const { readPasswordFile } = await modules();
    expect(() => readPasswordFile(join(home, 'missing'))).toThrow(/^--password-file: cannot read .*missing \(ENOENT\)$/);
  });

  it('signs with the password from --password-file', async () => {
    const { resolveConfig, deferredAccount } = await modules();
    const account = await deferredAccount(resolveConfig({ passwordFile }), undefined);
    expect(await account.signMessage({ message: 'hi' })).toBe(await real.signMessage({ message: 'hi' }));
  }, 20_000);

  it('without a terminal and without a password, fails naming the options instead of prompting', async () => {
    const { resolveConfig, assertCanUnlock, promptSecret, requireAccount } = await modules();
    const cfg = resolveConfig({});
    expect(() => assertCanUnlock(cfg, undefined, false)).toThrow(/password-protected and stdin is not a terminal: set RADIUS_PASSWORD or pass --password-file <path>/);
    // Fine with a password, a private key, or a terminal to prompt on.
    expect(() => assertCanUnlock(resolveConfig({ passwordFile }), undefined, false)).not.toThrow();
    expect(() => assertCanUnlock(cfg, privateKey, false)).not.toThrow();
    expect(() => assertCanUnlock(cfg, undefined, true)).not.toThrow();
    await expect(promptSecret('Keystore password:', false)).rejects.toThrow(/^Keystore password needed but stdin is not a terminal: set RADIUS_PASSWORD or pass --password-file <path>$/);
    // The lazy unlock path (wallet pay, sell check --pay) gives the same answer under vitest, which has no TTY.
    if (!process.stdin.isTTY) await expect(requireAccount(cfg, undefined)).rejects.toThrow(/stdin is not a terminal/);
  });
});

describe('sell check --pay without a terminal', () => {
  class Exit extends Error {
    constructor(readonly code: number) { super(`exit ${code}`); }
  }
  const tty = process.stdin.isTTY;
  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exits 2 before any request when the keystore would need a prompt', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const fetch = vi.fn(() => { throw new Error('no request expected'); });
    vi.stubGlobal('fetch', fetch);
    const { registerSell } = await import('../src/commands/sell.js');
    const program = new Command().option('--network <name>').option('--rpc-url <url>').option('--private-key <hex>').option('--password-file <path>').option('--sbc <address>').option('--rusd <address>').option('--json');
    registerSell(program);
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code ?? 0); }) as never);
    const code = await program.parseAsync(['node', 'radius-cli', 'sell', 'check', 'http://127.0.0.1:9/api/report', '--pay', '--threshold', '0.01']).then(
      () => { throw new Error('did not exit'); },
      (e: unknown) => { if (e instanceof Exit) return e.code; throw e; },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/sell check: the keystore at .* is password-protected and stdin is not a terminal: set RADIUS_PASSWORD or pass --password-file <path>/);
    expect(stderr).not.toContain(PASSWORD);
    expect(fetch).not.toHaveBeenCalled();
  });
});
