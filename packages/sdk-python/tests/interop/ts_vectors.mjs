// Golden vectors from the TypeScript SDK for the Python port: the same inputs, run through the TS implementation.
// Usage: node ts_vectors.mjs < cases.json → prints the results as JSON.
import { readFileSync } from 'node:fs';
import { toAtomic, formatAmount, resolveNetwork, describeSupportedSchemes, decodePaymentReceipt, radiusEnv, NETWORK_NAMES } from '../../../sdk/dist/index.js';
import { canonicalJson, encodeRequest, mppChallengeId, mppChallengeNonce, serializeMppChallenge, parseMppChallenges, serializeMppCredential, serializeMppReceipt } from '../../../sdk/dist/mpp.js';
import { permit2WitnessTypeString, permit2WitnessHash, nativeBalanceBytecode, encodeTypedDataType } from '../../../sdk/dist/client/index.js';

const cases = JSON.parse(readFileSync(0, 'utf8'));
const attempt = (fn) => { try { return { ok: fn() }; } catch (e) { return { error: e.message }; } };
const jsonSafe = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const challengeOf = (c) => ({ ...c, requestEncoded: encodeRequest(c.request) });
// A challenge as parseMppChallenges builds it (that key order is what a real credential echoes).
const parsedOrder = (c, id) => {
  const o = { id, realm: c.realm, method: c.method, intent: c.intent, request: c.request, requestEncoded: encodeRequest(c.request) };
  for (const k of ['description', 'digest', 'expires', 'header', 'opaque']) if (c[k] !== undefined) o[k] = c[k];
  return o;
};

const out = {
  toAtomic: cases.toAtomic.map(([p, d]) => attempt(() => toAtomic(p, d))),
  formatAmount: cases.formatAmount.map(([a, d, s]) => formatAmount(a, d, s)),
  canonicalJson: cases.canonicalJson.map((v) => canonicalJson(v)),
  encodeRequest: cases.canonicalJson.filter((v) => v && typeof v === 'object' && !Array.isArray(v)).map((v) => encodeRequest(v)),
  challengeId: await Promise.all(cases.challenges.map((c) => mppChallengeId(cases.secret, challengeOf(c)))),
  challengeNonce: cases.challenges.map((c, i) => mppChallengeNonce({ id: `n${i}`, realm: c.realm })),
  serializeChallenge: await Promise.all(cases.challenges.map(async (c) => serializeMppChallenge({ ...challengeOf(c), id: await mppChallengeId(cases.secret, challengeOf(c)) }))),
  parseChallenges: cases.headers.map((h) => parseMppChallenges(h).map(({ requestEncoded, ...rest }) => ({ ...rest, requestEncoded }))),
  credential: cases.challenges.map((c) => serializeMppCredential(parsedOrder(c, 'fixed'), cases.payload, 'did:pkh:eip155:72344:0x70997970C51812dc3A010C7d01b50e0d17dc79C8')),
  receipt: serializeMppReceipt({ method: 'evm', reference: '0xabc', status: 'success', timestamp: '2030-01-01T00:00:00.000Z' }),
  witnessTypeString: cases.witnesses.map((w) => permit2WitnessTypeString(w)),
  witnessHash: cases.witnesses.map((w) => permit2WitnessHash({ ...w, value: Object.fromEntries(Object.entries(w.value).map(([k, v]) => [k, typeof v === 'number' ? BigInt(v) : v])) })),
  encodeType: cases.encodeType.map(([primary, types]) => encodeTypedDataType(primary, types)),
  nativeBalanceBytecode: cases.addresses.map((a) => nativeBalanceBytecode(a)),
  networks: NETWORK_NAMES.map((n) => { const r = resolveNetwork(n); return { id: n, name: r.name, chainId: r.chainId, network: r.network, rpcUrl: r.rpcUrl, explorerUrl: r.explorerUrl ?? null, facilitatorUrl: r.facilitatorUrl ?? null, faucetUrl: r.faucetUrl ?? null, asset: r.asset, testnet: r.testnet, radius: r.radius, v1Names: r.v1Names, native: r.chain.nativeCurrency }; }),
  schemes: describeSupportedSchemes(),
  receipts: cases.receipts.map((h) => attempt(() => jsonSafe(decodePaymentReceipt(h, resolveNetwork('testnet'))))),
  env: cases.env.map((e) => attempt(() => radiusEnv(e))),
};
process.stdout.write(JSON.stringify(out));
