import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProgramStatus, formatReport } from '../src/lib/programStatus.js';
import { expectConformant, parseReports, violations } from './helpers/osc7501.js';

const cliDir = fileURLToPath(new URL('..', import.meta.url));
const bin = join(cliDir, 'dist/index.js');
const ptyRun = fileURLToPath(new URL('./helpers/pty-run.py', import.meta.url));

/** Drive a ProgramStatus against a fake terminal, exit the process, and return every byte it wrote. */
async function runAsync(scenario: (status: ProgramStatus) => Promise<void>, exitCode = 0): Promise<string> {
  let bytes = '';
  let exit: (code: number) => void = () => {};
  const status = new ProgramStatus();
  status.install({ env: {}, isTTY: true, write: (c) => { bytes += c; }, onExit: (fn) => { exit = fn; } });
  await scenario(status).catch(() => {});
  exit(exitCode);
  return bytes;
}

class ExitPromptError extends Error {
  override name = 'ExitPromptError';
}

describe('the CLI’s reporter follows the protocol', () => {
  it('a run that never waited sends nothing', async () => {
    expect(expectConformant(await runAsync(async () => {}))).toEqual([]);
  });

  it('a password prompt on its own', async () => {
    const bytes = await runAsync(async (s) => { await s.whileBlocked('auth', 'Keystore password needed', async () => 'pw'); });
    expect(expectConformant(bytes).map((r) => r.state)).toEqual(['blocked', 'working']);
  });

  it('a successful network run', async () => {
    const bytes = await runAsync(async (s) => {
      await s.whileBlocked('auth', 'Keystore password needed', async () => 'pw');
      s.working('Requesting a faucet drip on radius');
      s.succeeded('Received faucet drip');
    });
    expect(expectConformant(bytes).at(-1)).toMatchObject({ state: 'done' });
  });

  it('a failed network run', async () => {
    const bytes = await runAsync(async (s) => { s.working('Paying 0.001 SBC on Radius'); }, 1);
    expect(expectConformant(bytes).at(-1)).toMatchObject({ state: 'error' });
  });

  it('a declined prompt', async () => {
    const bytes = await runAsync(async (s) => {
      await s.whileBlocked('permission', 'Pay 0.001 SBC?', async () => false);
      s.cancel('Payment declined');
    }, 1);
    expect(expectConformant(bytes).at(-1)).toMatchObject({ state: 'idle' });
  });

  it('a prompt cancelled with Ctrl-C', async () => {
    const bytes = await runAsync(async (s) => {
      await s.whileBlocked('auth', 'Keystore password needed', async () => { throw new ExitPromptError('force closed'); });
    }, 1);
    expect(expectConformant(bytes).map((r) => r.state)).toEqual(['blocked', 'idle']);
  });

  it('a message with control characters, a long message and non-ASCII text', async () => {
    const bytes = await runAsync(async (s) => {
      s.working(`a\x1b]0;evil\x07b ${'é'.repeat(3000)} → ✓`);
      s.succeeded('Done ✓');
    });
    expectConformant(bytes);
  });
});

describe('the checker catches what it should', () => {
  const seq = (pairs: string) => `\x1b]7501;${pairs}\x1b\\`;
  const check = (stream: string) => {
    const { reports, problems } = parseReports(stream);
    return [...problems, ...violations(reports)];
  };

  it('accepts what the CLI sends', () => {
    expect(check(formatReport({ state: 'blocked', kind: 'auth', msg: 'x' }) + formatReport({ state: 'working' }))).toEqual([]);
  });

  it.each([
    ['an unknown state', seq('state=busy:app=radius-cli'), 'state must be one of'],
    ['a missing app', seq('state=working'), 'app must be'],
    ['kind on a non-blocked state', seq('state=working:app=radius-cli:kind=auth'), 'kind is only valid'],
    ['an unknown kind', seq('state=blocked:app=radius-cli:kind=oops') + seq('state=idle:app=radius-cli'), 'kind must be one of'],
    ['blocked without a kind', seq('state=blocked:app=radius-cli') + seq('state=idle:app=radius-cli'), 'blocked needs a kind'],
    ['msg that is not base64 of UTF-8', seq('state=working:app=radius-cli:msg=hello world'), 'canonical base64'],
    ['an empty msg', seq('state=working:app=radius-cli:msg='), 'empty msg'],
    ['msg with a control character', seq(`state=working:app=radius-cli:msg=${Buffer.from('a\nb').toString('base64')}`), 'control character'],
    ['an unterminated sequence', '\x1b]7501;state=working:app=radius-cli', 'not terminated'],
    ['an app the spec does not allow', seq('state=working:app=radius cli'), 'app must match'],
    ['an oversized msg', seq(`state=working:app=radius-cli:msg=${Buffer.from('a'.repeat(2049)).toString('base64')}`), 'msg is over 2048'],
    ['an unknown field', seq('state=working:app=radius-cli:id=1'), 'unknown field'],
    ['ending while blocked', seq('state=blocked:app=radius-cli:kind=auth'), 'still blocked'],
    ['reports after a cancel', seq('state=idle:app=radius-cli') + seq('state=working:app=radius-cli'), 'nothing may follow'],
    ['a network wait that never ends', seq(`state=working:app=radius-cli:msg=${Buffer.from('Paying').toString('base64')}`), 'must end with done, error or idle'],
  ])('rejects %s', (_name, stream, expected) => {
    expect(check(stream).join('\n')).toContain(expected);
  });

  it('puts the fix in the failure message', () => {
    expect(() => expectConformant(seq('state=busy:app=radius-cli'))).toThrow(/programStatus\.whileBlocked/);
  });
});

// A real terminal is the only way to see the CLI choose to report, so one run goes through a pty.
// `wallet new` in a temporary home reaches no network and no funds.
const havePython = spawnSync('python3', ['--version']).status === 0;
const haveBin = existsSync(bin);
if (process.env.CI && !haveBin) {
  it('the CLI is built before the tests run', () => {
    throw new Error('packages/cli/dist is missing. Run `pnpm build` before `pnpm test`; CI does.');
  });
}

describe.skipIf(!havePython || !haveBin)('built CLI on a terminal', () => {
  const password = 'throwaway-test-password';

  function onTerminal(args: string[], env: Record<string, string> = {}): string {
    const home = mkdtempSync(join(tmpdir(), 'radius-pty-'));
    const out = join(home, 'terminal.out');
    try {
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        RADIUS_HOME: home,
        RADIUS_KEYSTORE_PATH: join(home, 'keystore.json'),
        CI: '',
        TERM: 'xterm-256color',
        ...env,
      };
      for (const key of Object.keys(childEnv)) if (key.startsWith('RADIUS_') && !['RADIUS_HOME', 'RADIUS_KEYSTORE_PATH', ...Object.keys(env)].includes(key)) delete childEnv[key];
      const result = spawnSync('python3', ['-I', ptyRun, out, password, process.execPath, bin, ...args], { env: childEnv, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(out, 'utf8');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('reports each password prompt as blocked and then working, and never leaks the password', () => {
    const terminal = onTerminal(['wallet', 'new']);
    const reports = expectConformant(terminal);
    expect(reports.map((r) => `${r.state}${r.kind ? `:${r.kind}` : ''}`)).toEqual([
      'blocked:auth', 'working', 'blocked:auth', 'working',
    ]);
    expect(terminal).not.toContain(password);
  });

  it.each([
    ['RADIUS_NO_PROGRAM_STATUS', { RADIUS_NO_PROGRAM_STATUS: '1' }],
    ['CI', { CI: 'true' }],
    ['TERM=dumb', { TERM: 'dumb' }],
  ])('sends nothing with %s set', (_name, env) => {
    expect(onTerminal(['wallet', 'new'], env)).not.toContain('\x1b]7501');
  });
});

describe('the built CLI off a terminal', () => {
  it.skipIf(!haveBin)('writes nothing to a pipe with --json', () => {
    const home = mkdtempSync(join(tmpdir(), 'radius-pipe-'));
    try {
      const out = spawnSync(process.execPath, [bin, '--json', 'wallet', 'address'], {
        env: { ...process.env, RADIUS_HOME: home, RADIUS_KEYSTORE_PATH: join(home, 'keystore.json'), CI: '' },
        encoding: 'utf8',
      });
      expect(out.stdout + out.stderr).not.toContain('\x1b]7501');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Coverage guard. Every prompt and every network wait in the CLI must report, so a new one that
// forgets fails here, with the fix in the message. A scan, not an AST: at this size it is the least
// brittle option, and the allowlist records every exception with its reason.
describe('every prompt and network wait reports status', () => {
  const srcDir = join(cliDir, 'src');
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
    );
  const sources = files(srcDir)
    .filter((f) => !f.endsWith('programStatus.ts'))
    .map((f) => ({ file: relative(cliDir, f), text: readFileSync(f, 'utf8') }));
  const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

  /** A file with an exception to the rule. A stale entry fails, so the list cannot rot. */
  const NETWORK_ALLOWLIST: { file: string; reason: string }[] = [
    { file: 'src/lib/http.ts', reason: 'Shared fetch helper; the commands that call it report. See the runRequest check below.' },
  ];
  const RUNREQUEST_ALLOWLIST: { file: string; reason: string }[] = [];

  it('prompts: every file that imports @inquirer/prompts wraps each prompt in whileBlocked', () => {
    const promptFiles = sources.filter((s) => s.text.includes('@inquirer/prompts'));
    expect(promptFiles.length).toBeGreaterThan(0);
    for (const { file, text } of promptFiles) {
      const prompts = count(text, /\b(?:confirm|promptPassword|input|select|password)\(/g);
      const wrapped = count(text, /programStatus\.whileBlocked\(/g);
      expect(
        prompts,
        `${file} has ${prompts} prompt call(s) but ${wrapped} programStatus.whileBlocked(...) wrapper(s). ` +
          "Wrap each prompt: programStatus.whileBlocked('auth' | 'permission' | 'question', 'Short message', () => prompt(...)).",
      ).toBe(wrapped);
    }
  });

  it('network waits: a file that waits on the network calls programStatus.working', () => {
    const waiting = sources.filter((s) => /waitForTransactionReceipt\(|\bfetch\(/.test(s.text));
    const allowed = new Set(NETWORK_ALLOWLIST.map((a) => a.file));
    for (const { file, text } of waiting) {
      if (allowed.has(file)) continue;
      expect(
        text.includes('programStatus.working('),
        `${file} waits on the network but never calls programStatus.working(...). ` +
          'Call programStatus.working("Doing X") before the wait and programStatus.succeeded("Did X") after it, ' +
          'or add an entry with a reason to NETWORK_ALLOWLIST in this test.',
      ).toBe(true);
    }
    for (const a of NETWORK_ALLOWLIST) {
      const src = sources.find((s) => s.file === a.file);
      expect(src && /waitForTransactionReceipt\(|\bfetch\(/.test(src.text), `stale NETWORK_ALLOWLIST entry: ${a.file}`).toBe(true);
    }
  });

  it('callers of the shared fetch helper report status', () => {
    const allowed = new Set(RUNREQUEST_ALLOWLIST.map((a) => a.file));
    const callers = sources.filter((s) => /\brunRequest\b/.test(s.text) && s.file !== 'src/lib/http.ts');
    for (const { file, text } of callers) {
      if (allowed.has(file)) continue;
      expect(
        text.includes('programStatus.working('),
        `${file} calls runRequest but never calls programStatus.working(...). Report the wait, or add an entry with a reason to RUNREQUEST_ALLOWLIST.`,
      ).toBe(true);
    }
    for (const a of RUNREQUEST_ALLOWLIST) {
      const src = sources.find((s) => s.file === a.file);
      expect(src && /\brunRequest\b/.test(src.text) && !src.text.includes('programStatus.working('), `stale RUNREQUEST_ALLOWLIST entry: ${a.file}`).toBe(true);
    }
  });
});
