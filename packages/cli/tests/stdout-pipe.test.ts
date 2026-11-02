import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Spawns the built CLI with stdout as a pipe. On a pipe Node writes stdout asynchronously, so a
// process.exit() right after a large write drops whatever is still buffered. The server is local
// and answers 200, so no payment is involved and no wallet is read.

const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const BODY = 'radius '.repeat(1024 * 1024); // 7 MiB

let server: Server;
let base: string;
let home: string;

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run pnpm build first`);
  home = mkdtempSync(join(tmpdir(), 'radius-cli-pipe-'));
  server = createServer((req, res) => {
    const status = req.url === '/missing' ? 404 : 200;
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.closeAllConnections();
  server?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

function run(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, RADIUS_HOME: home };
    for (const k of Object.keys(env)) if (k.startsWith('RADIUS_') && k !== 'RADIUS_HOME') delete env[k];
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    // Read slowly so the pipe fills and the CLI's writes back up.
    child.stdout.on('data', (c: Buffer) => {
      chunks.push(c);
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), 1);
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') }));
  });
}

it('writes a large --json response to a pipe in full', async () => {
  const { code, stdout } = await run(['--json', 'wallet', 'pay', 'get', `${base}/big`]);
  const out = JSON.parse(stdout);
  expect(code).toBe(0);
  expect(out.status).toBe(200);
  expect(out.body.length).toBe(BODY.length);
  expect(out.payment).toBeNull();
}, 30_000);

it('writes a large raw body to a pipe in full and keeps exit code 1 on an HTTP error', async () => {
  const { code, stdout } = await run(['wallet', 'pay', 'get', `${base}/missing`]);
  expect(code).toBe(1);
  expect(stdout.length).toBe(BODY.length);
}, 30_000);

it('sell check still exits with its code when the route is not paid', async () => {
  // A 200 is not a 402: the check fails before any facilitator is asked.
  const { code, stdout } = await run(['--json', 'sell', 'check', `${base}/big`]);
  expect(code).toBe(1);
  expect(JSON.parse(stdout)).toBeTypeOf('object');
}, 30_000);
