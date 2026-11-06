import { describe, expect, it } from 'vitest';
import { createPublicClient, custom, decodeFunctionData, erc20Abi, encodeAbiParameters, encodeEventTopics, maxUint256, numberToHex, type Address, type Hex } from 'viem';
import { radiusTestnetChain, SBC } from 'radius-sdk';
import { describeToken, formatBalanceLines, listTransfers, parseAmountArg, parseTokenArg, readBalances, sbcToken, sortTransfers, toTransferRow, transferFilters, type BalanceReport } from '../src/lib/erc20.js';
import type { TokenTransfer } from 'radius-sdk/client';
import type { ResolvedConfig } from '../src/types.js';

const OWNER: Address = '0x4f2d8a3b1c0e5d9b8e7a6c5d4e3f2a1b0c9d8e7f';
const USDX: Address = '0x2222222222222222222222222222222222222222';
const CUSTOM_SBC: Address = '0x3333333333333333333333333333333333333333';

const cfg: ResolvedConfig = { network: 'testnet', chain: radiusTestnetChain, rpcUrl: 'http://unused', sbcAddress: SBC.address, keystorePath: '', password: '' };
const word = (v: bigint | number) => numberToHex(BigInt(v), { size: 32 });
const str = (s: string) => encodeAbiParameters([{ type: 'string' }], [s]);

/** A read-only Radius node: eth_getBalance aggregates native + SBC, the init-code eth_call returns native only. */
type FakeLog = { from: Address; to: Address; amount: bigint; block: bigint; logIndex: number; hash: Hex };
const transferLog = (l: FakeLog) => ({
  address: SBC.address,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: l.from, to: l.to } }),
  data: word(l.amount),
  blockNumber: numberToHex(l.block),
  transactionHash: l.hash,
  logIndex: numberToHex(l.logIndex),
  transactionIndex: '0x0',
  blockHash: numberToHex(l.block, { size: 32 }),
  removed: false,
});

function readNode(opts: { native: bigint; sbc: bigint; sbcFails?: boolean; logs?: FakeLog[]; filters?: unknown[] }) {
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const p = (params ?? []) as never[];
        switch (method) {
          case 'eth_chainId':
            return numberToHex(radiusTestnetChain.id);
          case 'eth_getBalance':
            return numberToHex(opts.native + opts.sbc * 10n ** 12n);
          case 'eth_getLogs': {
            const filter = p[0] as { topics: (Hex | null)[] };
            opts.filters?.push(filter);
            const [, fromTopic, toTopic] = filter.topics;
            const matches = (topic: Hex | null | undefined, addr: Address) => !topic || topic.toLowerCase() === numberToHex(BigInt(addr), { size: 32 }).toLowerCase();
            return (opts.logs ?? []).filter((l) => matches(fromTopic, l.from) && matches(toTopic, l.to)).map(transferLog);
          }
          case 'eth_call': {
            const tx = p[0] as { to?: Address; data?: Hex };
            if (!tx.to) return word(opts.native); // nativeBalanceBytecode: EVM BALANCE of the account
            const { functionName } = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
            const isSbc = tx.to.toLowerCase() === SBC.address.toLowerCase();
            switch (functionName) {
              case 'balanceOf':
                if (opts.sbcFails) throw new Error('execution reverted');
                return word(opts.sbc);
              case 'decimals': return word(isSbc ? 6 : 18);
              case 'symbol': return str(isSbc ? 'SBC' : 'USDX');
              case 'name': return str(isSbc ? 'Stable Coin' : 'USDX Token');
              case 'totalSupply': return word(1n);
              default: throw new Error(`unexpected view ${functionName}`);
            }
          }
          default:
            throw new Error(`unexpected RPC method ${method}`);
        }
      },
    },
    { retryCount: 0 },
  );
  return createPublicClient({ chain: radiusTestnetChain, transport });
}

describe('token arguments', () => {
  it('SBC resolves to the configured contract with its decimals known up front', () => {
    expect(parseTokenArg(cfg, 'SBC')).toEqual({ address: SBC.address, symbol: 'SBC', decimals: 6, convertible: true });
    expect(parseTokenArg({ ...cfg, sbcAddress: CUSTOM_SBC }, 'sbc')).toMatchObject({ address: CUSTOM_SBC, decimals: 6 });
    expect(sbcToken({ ...cfg, sbcAddress: undefined }).address).toBe(SBC.address);
  });
  it('a 0x address is passed through for the SDK to read on-chain; anything else is rejected', () => {
    expect(parseTokenArg(cfg, USDX)).toBe(USDX);
    expect(() => parseTokenArg(cfg, 'RUSD')).toThrow(/SBC or a 0x contract address/);
    expect(() => parseTokenArg(cfg, '0x1234')).toThrow(/SBC or a 0x contract address/);
  });
  it('amounts stay display strings for the SDK to parse; "max" is an unlimited approval', () => {
    expect(parseAmountArg('1.5')).toBe('1.5');
    expect(parseAmountArg(' 10 ')).toBe('10');
    expect(parseAmountArg('MAX')).toBe(maxUint256);
    expect(() => parseAmountArg('-1')).toThrow(/decimal number/);
    expect(() => parseAmountArg('1e6')).toThrow(/decimal number/);
  });
  it('describeToken reads symbol and decimals only for a bare address', async () => {
    const client = readNode({ native: 0n, sbc: 0n });
    expect(await describeToken(client, sbcToken(cfg))).toEqual(sbcToken(cfg));
    expect(await describeToken(client, USDX)).toEqual({ address: USDX, symbol: 'USDX', decimals: 18 });
  });
});

describe('readBalances', () => {
  it('keeps native RUSD and SBC apart so the total is not double counted', async () => {
    const client = readNode({ native: 2_345_678_000_000_000_000n, sbc: 10_000_000n });
    const r = await readBalances(client, cfg, OWNER);
    expect(r).toEqual({
      address: OWNER,
      totalUsd: 12.345678,
      sbc: '10',
      rusd: '2.345678',
      sbcWei: '10000000',
      rusdWei: '2345678000000000000',
      aggregateWei: '12345678000000000000',
      rusdSource: 'evm',
      sbcError: null,
    });
  });
  it('falls back to the aggregate balance, with the error, when the SBC read fails', async () => {
    const client = readNode({ native: 1_000_000_000_000_000_000n, sbc: 5_000_000n, sbcFails: true });
    const r = await readBalances(client, cfg, OWNER);
    expect(r.sbcError).toMatch(/execution reverted/);
    expect(r.rusdSource).toBe('aggregate');
    expect(r.rusd).toBe('6');
    expect(r.rusdWei).toBe('6000000000000000000');
    expect(r.sbc).toBe('0');
    expect(r.totalUsd).toBe(6);
  });
});

describe('formatBalanceLines', () => {
  const report: BalanceReport = {
    address: OWNER,
    totalUsd: 0.159963,
    sbc: '0.030002',
    rusd: '0.129961',
    sbcWei: '30002',
    rusdWei: '129961000000000000',
    aggregateWei: '159963000000000000',
    rusdSource: 'evm',
    sbcError: null,
  };

  it('prints one greppable line per asset and the total', () => {
    expect(formatBalanceLines(report)).toEqual([
      `Address: ${OWNER}`,
      'SBC:     0.030002 SBC',
      'RUSD:    0.129961 RUSD',
      'Total:   0.159963 USD',
    ]);
  });

  it('marks SBC unavailable when its read failed, keeping a multi-line error to its first line', () => {
    const sbcError = 'HTTP request failed.\n\nURL: https://rpc.example\nRequest body: {}';
    const lines = formatBalanceLines({ ...report, sbcError });
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('SBC:     unavailable (HTTP request failed.)');
  });
});

describe('transfers', () => {
  const H = (n: number): Hex => numberToHex(BigInt(n), { size: 32 });
  const t = (o: Partial<TokenTransfer>): TokenTransfer => ({ token: SBC.address, from: OWNER, to: USDX, amount: 1n, transactionHash: H(1), blockNumber: 1n, logIndex: 0, ...o });

  it('explicit sides win, address expands to both directions, nothing means everything', () => {
    expect(transferFilters({ from: OWNER, to: USDX, address: CUSTOM_SBC })).toEqual([{ from: OWNER, to: USDX }]);
    expect(transferFilters({ to: USDX })).toEqual([{ from: undefined, to: USDX }]);
    expect(transferFilters({ address: OWNER })).toEqual([{ from: OWNER }, { to: OWNER }]);
    expect(transferFilters({})).toEqual([{}]);
  });
  it('sortTransfers dedupes a self-transfer seen from both sides and orders by block then log index', () => {
    const a = t({ blockNumber: 5n, logIndex: 2, transactionHash: H(5) });
    const b = t({ blockNumber: 5n, logIndex: 1, transactionHash: H(5) });
    const c = t({ blockNumber: 2n, logIndex: 9, transactionHash: H(2) });
    expect(sortTransfers([a, c, b, { ...a }])).toEqual([c, b, a]);
  });
  it('toTransferRow formats with the token decimals and stringifies bigints', () => {
    expect(toTransferRow(t({ amount: 1_500_000n, blockNumber: 77n }), sbcToken(cfg))).toEqual({
      token: SBC.address, symbol: 'SBC', from: OWNER, to: USDX, amount: '1.5', amountWei: '1500000', transactionHash: H(1), blockNumber: '77', logIndex: 0,
    });
  });
  it('listTransfers queries each side and merges the decoded logs', async () => {
    const filters: { topics: (Hex | null)[]; fromBlock?: Hex; toBlock?: Hex }[] = [];
    const logs: FakeLog[] = [
      { from: OWNER, to: USDX, amount: 2_000_000n, block: 10n, logIndex: 0, hash: H(10) },
      { from: USDX, to: OWNER, amount: 500_000n, block: 8n, logIndex: 3, hash: H(8) },
      { from: USDX, to: CUSTOM_SBC, amount: 1n, block: 9n, logIndex: 0, hash: H(9) }, // not ours
      { from: OWNER, to: OWNER, amount: 7n, block: 9n, logIndex: 1, hash: H(9) }, // matches both sides once
    ];
    const client = readNode({ native: 0n, sbc: 0n, logs, filters });
    const got = await listTransfers(client, { token: sbcToken(cfg), address: OWNER, fromBlock: 5n, toBlock: 12n });
    expect(got.map((x) => [x.blockNumber, x.logIndex, x.amount])).toEqual([[8n, 3, 500_000n], [9n, 1, 7n], [10n, 0, 2_000_000n]]);
    expect(filters).toHaveLength(2);
    expect(filters.map((f) => [f.fromBlock, f.toBlock])).toEqual([[numberToHex(5n), numberToHex(12n)], [numberToHex(5n), numberToHex(12n)]]);
  });
});
