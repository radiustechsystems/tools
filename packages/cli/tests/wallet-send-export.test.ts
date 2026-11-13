import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Spawns the built CLI against a local fake JSON-RPC server, with a throwaway key generated per run.
// Nothing reaches a real network and no funded wallet is read.

const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const TESTNET_CHAIN_ID = 72344;
const EXPLORER = 'https://testnet.radiustech.xyz/tx/';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';

let server: Server;
let rpcUrl: string;
let home: string;
let lastHash: Hex | undefined;

function rpcResult(method: string, params: unknown[]): unknown {
  switch (method) {
    case 'eth_chainId':
      return `0x${TESTNET_CHAIN_ID.toString(16)}`;
    case 'eth_gasPrice':
      return '0x3b9aca00';
    case 'eth_getTransactionCount':
      return '0x0';
    case 'eth_blockNumber':
      return '0x10';
    case 'eth_sendRawTransaction':
      lastHash = keccak256(params[0] as Hex);
      return lastHash;
    case 'eth_getTransactionReceipt':
      return {
        transactionHash: params[0],
        transactionIndex: '0x0',
        blockHash: `0x${'11'.repeat(32)}`,
        blockNumber: '0x10',
        from: RECIPIENT,
        to: RECIPIENT,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x3b9aca00',
        contractAddress: null,
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: '0x1',
        type: '0x0',
      };
    default:
      throw new Error(`unexpected RPC method ${method}`);
  }
}

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run pnpm build first`);
  home = mkdtempSync(join(tmpdir(), 'radius-cli-send-'));
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
      const answer = (r: { id: number; method: string; params?: unknown[] }) => {
        try {
          return { jsonrpc: '2.0', id: r.id, result: rpcResult(r.method, r.params ?? []) };
        } catch (err) {
          return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: (err as Error).message } };
        }
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.closeAllConnections();
  server?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

interface Run { code: number | null; stdout: string; stderr: string }

function run(args: string[], options: { stdin?: string; env?: Record<string, string> } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, RADIUS_HOME: home, ...options.env };
    for (const k of Object.keys(env)) if (k.startsWith('RADIUS_') && k !== 'RADIUS_HOME') delete env[k];
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    if (options.stdin !== undefined) child.stdin!.end(options.stdin);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function sendArgs(extra: string[]): string[] {
  const key = generatePrivateKey();
  return ['--network', 'testnet', '--rpc-url', rpcUrl, '--private-key', key, ...extra, 'wallet', 'send', RECIPIENT, '0.001', 'RUSD', '--gas-limit', '21000'];
}

describe('wallet send explorer link', () => {
  it('prints the explorer link after the receipt', async () => {
    const { code, stdout, stderr } = await run(sendArgs([]));
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(lastHash).toBeDefined();
    expect(stdout).toContain(`Hash:        ${lastHash}`);
    expect(stdout).toContain(`Explorer:    ${EXPLORER}${lastHash}`);
  });

  it('adds explorerUrl to the --json output', async () => {
    const { code, stdout } = await run(sendArgs(['--json']));
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { hash: string; receipt: { status: string }; explorerUrl: string };
    expect(out.hash).toBe(lastHash);
    expect(out.receipt.status).toBe('success');
    expect(out.explorerUrl).toBe(`${EXPLORER}${lastHash}`);
  });

  it('keeps --no-wait text output to the bare hash and prints the link on stderr', async () => {
    const { code, stdout, stderr } = await run([...sendArgs([]), '--no-wait']);
    expect(code).toBe(0);
    expect(stdout).toBe(`${lastHash}\n`);
    expect(stderr).toBe(`${EXPLORER}${lastHash}\n`);
  });

  it('adds explorerUrl to the --no-wait --json output', async () => {
    const { code, stdout } = await run([...sendArgs(['--json']), '--no-wait']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ hash: lastHash, explorerUrl: `${EXPLORER}${lastHash}` });
  });
});

describe('wallet export --yes', () => {
  it('prints the key without a prompt', async () => {
    const key = generatePrivateKey();
    const { code, stdout } = await run(['--json', '--private-key', key, 'wallet', 'export', '--yes']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ address: privateKeyToAccount(key).address, privateKey: key });
  });

  it('decrypts a passwordless keystore without a prompt', async () => {
    const keystoreHome = mkdtempSync(join(tmpdir(), 'radius-cli-export-'));
    try {
      const env = { RADIUS_HOME: keystoreHome };
      const created = await run(['--json', 'wallet', 'address'], { env });
      expect(created.code).toBe(0);
      const { address } = JSON.parse(created.stdout) as { address: string };
      const { code, stdout } = await run(['--json', 'wallet', 'export', '-y'], { env });
      expect(code).toBe(0);
      const out = JSON.parse(stdout) as { address: string; privateKey: Hex };
      expect(out.address).toBe(address);
      expect(privateKeyToAccount(out.privateKey).address).toBe(address);
    } finally {
      rmSync(keystoreHome, { recursive: true, force: true });
    }
  }, 30_000); // creating and decrypting the keystore runs scrypt twice

  it('without --yes and with no stdin, fails with a hint and prints no key', async () => {
    const key = generatePrivateKey();
    const { code, stdout, stderr } = await run(['--private-key', key, 'wallet', 'export']);
    expect(code).toBe(1);
    expect(stdout).not.toContain(key);
    expect(stderr).toContain('Pass --yes');
  });

  it('without --yes still asks, and a piped "n" prints no key', async () => {
    const key = generatePrivateKey();
    const { code, stdout } = await run(['--private-key', key, 'wallet', 'export'], { stdin: 'n\n' });
    expect(code).toBe(0);
    expect(stdout).toContain('Print the raw private key to stdout?');
    expect(stdout).not.toContain(key);
  });
});
