import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanMsg, formatReport, isEnabled, ProgramStatus, shortHex } from '../src/lib/programStatus.js';

/** Decode the reports written to a fake terminal: `[{state, app, kind?, msg?}]`. */
function decode(chunks: string[]): Record<string, string>[] {
  return chunks.map((c) => {
    expect(c.startsWith('\x1b]7501;')).toBe(true);
    expect(c.endsWith('\x1b\\')).toBe(true);
    const fields = Object.fromEntries(c.slice(7, -2).split(':').map((p) => p.split('=', 2) as [string, string]));
    if (fields.msg) fields.msg = Buffer.from(fields.msg, 'base64').toString('utf8');
    return fields;
  });
}

function installed() {
  const chunks: string[] = [];
  let exit: (code: number) => void = () => {};
  const status = new ProgramStatus();
  status.install({ env: {}, isTTY: true, write: (c) => chunks.push(c), onExit: (fn) => { exit = fn; } });
  return { status, reports: () => decode(chunks), exit: (code: number) => exit(code) };
}

class ExitPromptError extends Error {
  override name = 'ExitPromptError';
}

describe('formatReport', () => {
  it('names the app on every report and terminates with ST', () => {
    expect(formatReport({ state: 'working' })).toBe('\x1b]7501;state=working:app=radius-cli\x1b\\');
  });

  it('base64-encodes msg and adds kind', () => {
    const [r] = decode([formatReport({ state: 'blocked', kind: 'auth', msg: 'Pay 0.001 SBC on Radius → 0x1234…abcd?' })]);
    expect(r).toEqual({ state: 'blocked', app: 'radius-cli', kind: 'auth', msg: 'Pay 0.001 SBC on Radius → 0x1234…abcd?' });
  });

  it('omits an empty msg', () => {
    expect(formatReport({ state: 'idle', msg: ' \n ' })).toBe('\x1b]7501;state=idle:app=radius-cli\x1b\\');
  });
});

describe('cleanMsg', () => {
  it('strips control characters, escapes included, to one line', () => {
    expect(cleanMsg('a\x1b]0;evil\x07b\nc\x9bd')).toBe('a ]0;evil b c d');
  });

  it('cuts to 2048 UTF-8 bytes on a character boundary', () => {
    const out = cleanMsg('é'.repeat(1500));
    expect(Buffer.byteLength(out, 'utf8')).toBe(2048);
    expect(out).toBe('é'.repeat(1024));
  });
});

describe('isEnabled', () => {
  it('needs a terminal on stderr', () => {
    expect(isEnabled({}, true)).toBe(true);
    expect(isEnabled({}, false)).toBe(false);
    expect(isEnabled({}, undefined)).toBe(false);
  });

  it('is off with RADIUS_NO_PROGRAM_STATUS, CI or TERM=dumb', () => {
    expect(isEnabled({ RADIUS_NO_PROGRAM_STATUS: '1' }, true)).toBe(false);
    expect(isEnabled({ CI: 'true' }, true)).toBe(false);
    expect(isEnabled({ TERM: 'dumb' }, true)).toBe(false);
  });
});

describe('shortHex', () => {
  it('keeps the first 6 and last 4 characters', () => {
    expect(shortHex('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
    expect(shortHex('0x1234')).toBe('0x1234');
  });
});

describe('ProgramStatus', () => {
  it('reports nothing for a run that never waited', () => {
    const { reports, exit } = installed();
    exit(0);
    expect(reports()).toEqual([]);
  });

  it('writes nothing when disabled', async () => {
    const chunks: string[] = [];
    const status = new ProgramStatus();
    status.install({ env: {}, isTTY: false, write: (c) => chunks.push(c), onExit: () => {} });
    status.working('Paying 0.001 SBC on Radius');
    await status.whileBlocked('auth', 'Keystore password needed', async () => 'pw');
    status.finish(0);
    expect(chunks).toEqual([]);
  });

  it('a password prompt alone leaves only working, which the terminal drops at exit', async () => {
    const { status, reports, exit } = installed();
    expect(await status.whileBlocked('auth', 'Keystore password needed', async () => 'pw')).toBe('pw');
    exit(0);
    expect(reports().map((r) => r.state)).toEqual(['blocked', 'working']);
    expect(reports()[0]).toMatchObject({ kind: 'auth', msg: 'Keystore password needed' });
  });

  it('puts back the working state a prompt interrupted', async () => {
    const { status, reports } = installed();
    status.working('Paying 0.001 SBC on Radius');
    await status.whileBlocked('auth', 'Keystore password needed', async () => 'pw');
    expect(reports().at(-1)).toMatchObject({ state: 'working', msg: 'Paying 0.001 SBC on Radius' });
  });

  it('ends a run that worked with done and its outcome', () => {
    const { status, reports, exit } = installed();
    status.working('Waiting for transaction 0xabcd…1234');
    status.succeeded('Transaction confirmed');
    exit(0);
    expect(reports().at(-1)).toEqual({ state: 'done', app: 'radius-cli', msg: 'Transaction confirmed' });
  });

  it('ends a failed run with error and no text', () => {
    const { status, reports, exit } = installed();
    status.working('Paying 0.001 SBC on Radius');
    status.succeeded('Paid 0.001 SBC');
    exit(1);
    expect(reports().at(-1)).toEqual({ state: 'error', app: 'radius-cli' });
  });

  it('a decline reports idle and nothing more, whatever the exit code', () => {
    const { status, reports, exit } = installed();
    status.working('Paying 0.001 SBC on Radius');
    status.cancel('Payment declined');
    status.working('ignored');
    exit(1);
    expect(reports().map((r) => r.state)).toEqual(['working', 'idle']);
    expect(reports()[1].msg).toBe('Payment declined');
  });

  it('a prompt cancelled with Ctrl-C reports idle and rethrows', async () => {
    const { status, reports, exit } = installed();
    status.working('Paying 0.001 SBC on Radius');
    await expect(
      status.whileBlocked('permission', 'Pay 0.001 SBC?', async () => { throw new ExitPromptError('force closed'); }),
    ).rejects.toThrow('force closed');
    exit(1);
    expect(reports().map((r) => r.state)).toEqual(['working', 'blocked', 'idle']);
  });

  it('a write that throws never breaks the command', async () => {
    const status = new ProgramStatus();
    status.install({ env: {}, isTTY: true, write: () => { throw new Error('EPIPE'); }, onExit: () => {} });
    expect(await status.whileBlocked('auth', 'Keystore password needed', async () => 'pw')).toBe('pw');
  });
});

describe('built CLI', () => {
  const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));

  it.skipIf(!existsSync(bin))('writes no report when stderr is not a terminal', () => {
    const home = mkdtempSync(join(tmpdir(), 'radius-status-'));
    const out = spawnSync(process.execPath, [bin, '--json', 'wallet', 'address'], {
      env: { ...process.env, RADIUS_HOME: home, RADIUS_KEYSTORE_PATH: join(home, 'keystore.json'), CI: '' },
      encoding: 'utf8',
    });
    expect(out.status).toBe(0);
    expect(out.stdout + out.stderr).not.toContain('\x1b]7501');
  });
});
