/**
 * ERC-20 actions against a real EVM: a forge-compiled TestToken (test/fixtures) deployed into
 * @ethereumjs/evm behind evmNode. These prove state transitions, not calldata: balances and
 * allowances move, reverts surface as reverted receipts (or as estimateGas failures), `pending`
 * never masquerades as success, and Transfer logs are the ones the contract emitted.
 */
import { createPublicClient, createWalletClient, encodeDeployData, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { waitForTransactionReceipt } from 'viem/actions';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { erc20Actions, getTransfers, transferKey, watchTransfers, type TokenTransfer } from '../src/erc20.js';
import { getTokenBalance } from '../src/balances.js';
import { radiusTestnet } from '../src/networks.js';
import { evmNode } from './evmNode.js';
import artifact from './fixtures/TestToken.json' with { type: 'json' };

const OWNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const SPENDER = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
const OTHER: Address = '0x1111111111111111111111111111111111111111';
const SUPPLY = 1_000_000_000_000n; // 1e6 TST at 6 decimals
const chain = radiusTestnet.chain;

describe('ERC-20 actions executed by an EVM', () => {
  let node: Awaited<ReturnType<typeof evmNode>>;
  let token: { address: Address; symbol: string; decimals: number };
  let owner: ReturnType<typeof makeWallet>;
  let spender: ReturnType<typeof makeWallet>;
  let pub: ReturnType<typeof createPublicClient>;

  const makeWallet = (account: typeof OWNER) =>
    createWalletClient({ account, chain, transport: node.transport, pollingInterval: 5 }).extend(erc20Actions({ token }));
  const balance = async (address: Address) => (await getTokenBalance(pub, { address, token })).atomic;

  beforeAll(async () => {
    node = await evmNode({ chainId: chain.id, accounts: [OWNER.address, SPENDER.address] });
    const address = await node.deploy(encodeDeployData({ abi: artifact.abi as Abi, bytecode: artifact.bytecode as Hex, args: [6, SUPPLY] }), OWNER.address);
    token = { address, symbol: 'TST', decimals: 6 };
    pub = createPublicClient({ chain, transport: node.transport, pollingInterval: 5 });
    owner = makeWallet(OWNER);
    spender = makeWallet(SPENDER);
  });

  it('reads metadata and balances from executed bytecode', async () => {
    expect(await owner.getTokenMetadata()).toEqual({ address: token.address, name: 'Test Token', symbol: 'TST', decimals: 6, totalSupply: SUPPLY });
    expect(await balance(OWNER.address)).toBe(SUPPLY);
    expect(await balance(OTHER)).toBe(0n);
  });

  it('transfer moves balances and emits the Transfer the query returns', async () => {
    const r = await owner.transfer({ to: OTHER, amount: '1.5' });
    expect(r.status).toBe('success');
    expect(await balance(OWNER.address)).toBe(SUPPLY - 1_500_000n);
    expect(await balance(OTHER)).toBe(1_500_000n);
    const transfers = await getTransfers(pub, { token, fromBlock: node.blockNumber() - 100n, toBlock: node.blockNumber() });
    expect(transfers.map((t) => [t.from, t.to, t.amount])).toEqual([
      ['0x0000000000000000000000000000000000000000', OWNER.address, SUPPLY], // the mint
      [OWNER.address, OTHER, 1_500_000n],
    ]);
    expect(transfers[1]).toMatchObject({ token: token.address, transactionHash: r.hash, logIndex: 0 });
    expect(new Set(transfers.map(transferKey)).size).toBe(2);
  });

  it('approve sets (not adds) the allowance; transferFrom spends it and moves funds', async () => {
    await owner.approve({ spender: SPENDER.address, amount: '2.5' });
    expect(await owner.getAllowance({ owner: OWNER.address, spender: SPENDER.address })).toBe(2_500_000n);
    await owner.approve({ spender: SPENDER.address, amount: '2' });
    expect(await owner.getAllowance({ owner: OWNER.address, spender: SPENDER.address })).toBe(2_000_000n);

    const before = await balance(OWNER.address);
    const r = await spender.transferFrom({ from: OWNER.address, to: OTHER, amount: '1' });
    expect(r.status).toBe('success');
    expect(await owner.getAllowance({ owner: OWNER.address, spender: SPENDER.address })).toBe(1_000_000n);
    expect(await balance(OWNER.address)).toBe(before - 1_000_000n);
    expect(await balance(OTHER)).toBe(2_500_000n);
  });

  it('spending above the allowance fails at estimateGas, or reverts on-chain with an explicit gas limit', async () => {
    const ownerBefore = await balance(OWNER.address);
    const otherBefore = await balance(OTHER);
    await expect(spender.transferFrom({ from: OWNER.address, to: OTHER, amount: '5' })).rejects.toThrow(/insufficient allowance/);
    expect(node.methods().at(-1)).toBe('eth_estimateGas');

    const r = await spender.transferFrom({ from: OWNER.address, to: OTHER, amount: '5', gas: 100_000n });
    expect(r.status).toBe('reverted');
    const receipt = await pub.getTransactionReceipt({ hash: r.hash });
    expect(receipt.status).toBe('reverted');
    expect(receipt.logs).toEqual([]);
    expect(await owner.getAllowance({ owner: OWNER.address, spender: SPENDER.address })).toBe(1_000_000n);
    expect(await balance(OWNER.address)).toBe(ownerBefore);
    expect(await balance(OTHER)).toBe(otherBefore);
  });

  it('a transfer above the balance reverts, and pending is never reported as success', async () => {
    const other = createWalletClient({ account: SPENDER, chain, transport: node.transport, pollingInterval: 5 }).extend(erc20Actions({ token }));
    expect(await balance(SPENDER.address)).toBe(0n);
    await expect(other.transfer({ to: OTHER, amount: 1n })).rejects.toThrow(/insufficient balance/);
    expect((await other.transfer({ to: OTHER, amount: 1n, gas: 100_000n })).status).toBe('reverted');

    const r = await other.transfer({ to: OTHER, amount: 1n, gas: 100_000n, wait: false });
    expect(r.status).toBe('pending');
    expect((await waitForTransactionReceipt(pub, { hash: r.hash })).status).toBe('reverted');
    expect(await balance(OTHER)).toBe(2_500_000n);
  });

  it('nonces follow executed state', async () => {
    const start = node.sent.length;
    const nonce = await pub.getTransactionCount({ address: OWNER.address });
    await owner.transfer({ to: OTHER, amount: 1n });
    await owner.transfer({ to: OTHER, amount: 1n });
    const nonces = node.sent.slice(start).map((t) => t.nonce);
    expect(nonces).toEqual([nonce, nonce + 1]);
    expect(await pub.getTransactionCount({ address: OWNER.address })).toBe(nonce + 2);
  });

  it('watchTransfers sees a live transfer with the fields the contract emitted', async () => {
    const seen: TokenTransfer[] = [];
    const checkpoints: bigint[] = [];
    const unwatch = watchTransfers(pub, { blockLag: 0n, token, to: OTHER, fromBlock: node.blockNumber() + 1n, onTransfer: (t) => { seen.push(t); }, onCheckpoint: (b) => { checkpoints.push(b); }, pollingInterval: 5 });
    const r = await owner.transfer({ to: OTHER, amount: '0.25' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    unwatch();
    expect(seen[0]).toMatchObject({ token: token.address, from: OWNER.address, to: OTHER, amount: 250_000n, transactionHash: r.hash, logIndex: 0 });
    expect(checkpoints.at(-1)).toBe(node.blockNumber());
    expect(seen[0].blockNumber).toBe(node.blockNumber());
  });

  it('a query wider than the node cap is split into calls the node accepts', async () => {
    const head = node.blockNumber();
    const before = node.methods().filter((m) => m === 'eth_getLogs').length;
    const transfers = await getTransfers(pub, { token, to: OTHER, fromBlock: head - 2_500_000n, toBlock: head });
    expect(node.methods().filter((m) => m === 'eth_getLogs').length - before).toBe(3);
    expect(transfers.length).toBeGreaterThanOrEqual(4);
    expect(transfers.every((t) => t.to === OTHER)).toBe(true);
    // The same span in one call is what the node refuses.
    await expect(pub.getLogs({ address: token.address, fromBlock: head - 2_500_000n, toBlock: head })).rejects.toThrow(/block range is too wide/);
  });
});
