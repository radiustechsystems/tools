import { describe, expect, it } from 'vitest';
import { createPublicClient, custom, decodeFunctionData, erc20Abi, encodeAbiParameters, numberToHex, type Address, type Hex } from 'viem';
import { radiusTestnetChain, SBC } from 'radius-sdk';
import { formatBalanceLines, parseAmountArg, parseTokenArg, readBalances, sbcToken, type BalanceReport } from '../src/lib/erc20.js';
import type { ResolvedConfig } from '../src/types.js';

const OWNER: Address = '0x4f2d8a3b1c0e5d9b8e7a6c5d4e3f2a1b0c9d8e7f';
const USDX: Address = '0x2222222222222222222222222222222222222222';
const CUSTOM_SBC: Address = '0x3333333333333333333333333333333333333333';

const cfg: ResolvedConfig = { network: 'testnet', chain: radiusTestnetChain, rpcUrl: 'http://unused', sbcAddress: SBC.address, keystorePath: '', password: '' };
const word = (v: bigint | number) => numberToHex(BigInt(v), { size: 32 });
const str = (s: string) => encodeAbiParameters([{ type: 'string' }], [s]);

/** A read-only Radius node: eth_getBalance aggregates native + SBC, the init-code eth_call returns native only. */
function readNode(opts: { native: bigint; sbc: bigint; sbcFails?: boolean }) {
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const p = (params ?? []) as never[];
        switch (method) {
          case 'eth_chainId':
            return numberToHex(radiusTestnetChain.id);
          case 'eth_getBalance':
            return numberToHex(opts.native + opts.sbc * 10n ** 12n);
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
  it('amounts stay display strings for the SDK to parse with the token decimals', () => {
    expect(parseAmountArg('1.5')).toBe('1.5');
    expect(parseAmountArg(' 10 ')).toBe('10');
    expect(() => parseAmountArg('-1')).toThrow(/decimal number/);
    expect(() => parseAmountArg('1e6')).toThrow(/decimal number/);
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
      'SBC:     0.030002',
      'RUSD:    0.129961',
      'Total:   0.159963 USD',
    ]);
  });

  it('marks SBC unavailable when its read failed', () => {
    expect(formatBalanceLines({ ...report, sbcError: 'boom' })[1]).toBe('SBC:     unavailable (boom)');
  });
});
