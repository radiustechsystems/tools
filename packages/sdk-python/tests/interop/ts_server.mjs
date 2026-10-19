// A TypeScript-SDK seller for the Python interop tests: radiusPayments() behind node:http, settled by an
// in-process facilitator that recovers every EIP-3009 / Permit2 signature with viem before "settling".
// Usage: node ts_server.mjs '<json options>'  → prints {"port": N} once listening; logs facilitator calls as JSON lines on stderr.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// viem is a dependency of packages/sdk, not of this directory: resolve it from there.
const fromSdk = createRequire(new URL('../../../sdk/package.json', import.meta.url));
const { recoverTypedDataAddress } = await import(pathToFileURL(fromSdk.resolve('viem')).href);
import { radiusPayments } from '../../../sdk/dist/server/index.js';
import { resolveNetwork, PERMIT2_ADDRESS } from '../../../sdk/dist/index.js';

const opts = JSON.parse(process.argv[2] ?? '{}');
const network = resolveNetwork(opts.network ?? 'testnet');
const TX = '0x' + 'cd'.repeat(32);

const EIP3009 = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] };
const PERMIT2 = (witness) => ({
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  Witness: witness,
});

async function payer(payload, requirements) {
  const p = payload.payload;
  if (p.authorization) {
    const a = p.authorization;
    const signer = await recoverTypedDataAddress({
      domain: { name: requirements.extra.name, version: requirements.extra.version, chainId: network.chainId, verifyingContract: requirements.asset },
      types: EIP3009, primaryType: 'TransferWithAuthorization',
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
      signature: p.signature,
    });
    if (signer.toLowerCase() !== a.from.toLowerCase()) throw new Error('bad EIP-3009 signature');
    if (a.to.toLowerCase() !== requirements.payTo.toLowerCase() || a.value !== requirements.amount) throw new Error('authorization does not match requirements');
    return signer;
  }
  const a = p.permit2Authorization;
  const signer = await recoverTypedDataAddress({
    domain: { name: 'Permit2', chainId: network.chainId, verifyingContract: PERMIT2_ADDRESS },
    types: PERMIT2([{ name: 'to', type: 'address' }, { name: 'validAfter', type: 'uint256' }]), primaryType: 'PermitWitnessTransferFrom',
    message: { permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) }, spender: a.spender, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline), witness: { to: a.witness.to, validAfter: BigInt(a.witness.validAfter) } },
    signature: p.signature,
  });
  if (signer.toLowerCase() !== a.from.toLowerCase()) throw new Error('bad Permit2 signature');
  return signer;
}

const log = (event) => process.stderr.write(JSON.stringify(event) + '\n');
const facilitator = {
  async getSupported() {
    return {
      kinds: (opts.methods ?? ['eip3009', 'permit2']).map((assetTransferMethod) => ({ x402Version: 2, scheme: 'exact', network: network.network, extra: { assetTransferMethod, name: network.asset.name, version: network.asset.version } })),
      extensions: opts.extensions ?? ['eip2612GasSponsoring'],
      signers: {},
    };
  },
  async verify(payload, requirements) {
    try {
      const signer = await payer(payload, requirements);
      log({ op: 'verify', payload, requirements });
      return { isValid: true, payer: signer };
    } catch (e) {
      log({ op: 'verify', error: e.message });
      return { isValid: false, invalidReason: 'invalid_signature', invalidMessage: e.message };
    }
  },
  async settle(payload, requirements) {
    const signer = await payer(payload, requirements);
    log({ op: 'settle', payload, requirements });
    return { success: true, transaction: TX, network: requirements.network, payer: signer };
  },
};

const pay = radiusPayments({
  network,
  payTo: opts.payTo ?? '0x000000000000000000000000000000000000dEaD',
  facilitator,
  settle: opts.settle ?? 'before',
  ...(opts.mpp ? { mpp: { secretKey: 'interop-secret-key-0123456789abcdef', realm: opts.realm } } : {}),
  routes: opts.routes ?? { 'GET /api/lookup': { price: '$0.001', description: 'One lookup' }, 'POST /api/query': '$0.01' },
});
const app = pay.wrap(async (request, payment) => Response.json({ ok: true, method: request.method, body: request.method === 'GET' ? null : await request.text(), paidBy: payment?.payer ?? null }));

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const response = await app(request);
  const out = {};
  response.headers.forEach((v, k) => { out[k] = k in out ? `${out[k]}, ${v}` : v; });
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n'));
