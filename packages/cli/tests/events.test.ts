import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type AbiEvent, type Address, type Hex } from 'viem';
import { decodeLogs, parseEventSignature, type RawLog } from '../src/lib/events.js';

const TOKEN: Address = '0x1111111111111111111111111111111111111111';
const ALICE: Address = '0x2222222222222222222222222222222222222222';
const BOB: Address = '0x3333333333333333333333333333333333333333';

function makeLog(sig: string, args: Record<string, unknown>, logIndex: number): RawLog {
  const event = parseAbiItem(`event ${sig}`) as AbiEvent;
  const topics = encodeEventTopics({ abi: [event], eventName: event.name, args } as never) as Hex[];
  const dataInputs = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(dataInputs, dataInputs.map((i) => args[i.name!]));
  return { address: TOKEN, topics, data, logIndex };
}

const NFT_TRANSFER = 'Transfer(address indexed from, address indexed to, uint256 indexed tokenId)';
const ERC20_TRANSFER = 'Transfer(address indexed from, address indexed to, uint256 value)';
const REGISTERED = 'Registered(uint256 indexed agentId, string agentURI, address indexed owner)';

describe('parseEventSignature', () => {
  it('accepts an optional `event` prefix and counts indexed params', () => {
    const a = parseEventSignature(NFT_TRANSFER);
    const b = parseEventSignature(`event ${NFT_TRANSFER}`);
    expect(a.selector).toBe(b.selector);
    expect(a.indexedCount).toBe(3);
    expect(parseEventSignature(ERC20_TRANSFER).indexedCount).toBe(2);
  });

  it('rejects malformed signatures with a clear message', () => {
    expect(() => parseEventSignature('Transfer')).toThrow(/Invalid event signature/);
    expect(() => parseEventSignature('Transfer(address indexed from')).toThrow(/Invalid event signature/);
    expect(() => parseEventSignature('Transfer(adress from)')).toThrow(/Invalid event signature/);
    expect(() => parseEventSignature('1bad(uint256)')).toThrow(/Invalid event signature/);
    expect(() => parseEventSignature('Foo(uint256)garbage)')).toThrow(/trailing content 'garbage\)'/);
  });
});

describe('decodeLogs', () => {
  it('decodes an all-indexed event, keying unnamed params by position', () => {
    const log = makeLog(NFT_TRANSFER, { from: ALICE, to: BOB, tokenId: 42n }, 0);
    const { logs, warnings } = decodeLogs([log], [parseEventSignature('Transfer(address indexed,address indexed,uint256 indexed tokenId)')]);
    expect(warnings).toEqual([]);
    expect(logs).toEqual([{ address: TOKEN, logIndex: 0, eventName: 'Transfer', args: { 0: ALICE, 1: BOB, tokenId: 42n } }]);
  });

  it('decodes a mixed indexed / non-indexed event', () => {
    const log = makeLog(REGISTERED, { agentId: 7n, agentURI: 'ipfs://agent', owner: ALICE }, 3);
    const { logs } = decodeLogs([log], [parseEventSignature(REGISTERED)]);
    expect(logs).toEqual([{ address: TOKEN, logIndex: 3, eventName: 'Registered', args: { agentId: 7n, agentURI: 'ipfs://agent', owner: ALICE } }]);
    expect(Object.keys((logs[0] as { args: object }).args)).toEqual(['agentId', 'agentURI', 'owner']);
  });

  it('tries every --event against every log and passes non-matching logs through raw', () => {
    const transfer = makeLog(NFT_TRANSFER, { from: ALICE, to: BOB, tokenId: 1n }, 0);
    const registered = makeLog(REGISTERED, { agentId: 1n, agentURI: 'x', owner: BOB }, 1);
    const other = makeLog('Approval(address indexed owner, address indexed spender, uint256 value)', { owner: ALICE, spender: BOB, value: 5n }, 2);
    const { logs } = decodeLogs([transfer, registered, other], [parseEventSignature(NFT_TRANSFER), parseEventSignature(REGISTERED)]);
    expect(logs.map((l) => ('eventName' in l ? l.eventName : 'raw'))).toEqual(['Transfer', 'Registered', 'raw']);
    expect(logs[2]).toEqual({ address: TOKEN, logIndex: 2, topics: other.topics, data: other.data });
  });

  it('tells ERC-20 and ERC-721 Transfer apart by topic count', () => {
    const erc20 = makeLog(ERC20_TRANSFER, { from: ALICE, to: BOB, value: 100n }, 0);
    const erc721 = makeLog(NFT_TRANSFER, { from: ALICE, to: BOB, tokenId: 9n }, 1);
    const { logs, warnings } = decodeLogs([erc20, erc721], [parseEventSignature(ERC20_TRANSFER), parseEventSignature(NFT_TRANSFER)]);
    expect(warnings).toEqual([]);
    expect(logs.map((l) => ('args' in l ? l.args : null))).toEqual([
      { from: ALICE, to: BOB, value: 100n },
      { from: ALICE, to: BOB, tokenId: 9n },
    ]);
  });

  it('warns and passes the log through when `indexed` is missing from the signature', () => {
    const log = makeLog(NFT_TRANSFER, { from: ALICE, to: BOB, tokenId: 1n }, 4);
    const { logs, warnings } = decodeLogs([log], [parseEventSignature('Transfer(address,address,uint256)')]);
    expect(logs[0]).toEqual({ address: TOKEN, logIndex: 4, topics: log.topics, data: log.data });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/log 4 .*Transfer.*3 indexed topics.*declares 0.*indexed/);
  });
});
