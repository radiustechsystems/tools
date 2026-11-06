// End to end without funds: starts the seller on a free port with the local facilitator, shows the
// unpaid 402 and its MPP challenge, then pays it over MPP from a throwaway key. Exits non-zero if
// any step does not behave as described.
//   pnpm demo
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { generatePrivateKey } from 'viem/accounts';
import { radiusTestnet, type PaymentReceipt } from 'radius-sdk';
import { createRadiusFetch, getPaymentReceipt } from 'radius-sdk/client';
import { createSeller } from './app.ts';
import { localFacilitator } from './local-facilitator.ts';

const PAY_TO = '0x1eF420190c299D4d133fE9227F780D7d5cE91BeE';
const facilitator = localFacilitator();
const settled: PaymentReceipt[] = [];
const seller = createSeller({ payTo: PAY_TO, mppSecretKey: randomBytes(32).toString('base64'), facilitator, onSettled: (r) => settled.push(r) });

const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
  const s = serve({ fetch: seller, port: 0 }, () => resolve(s));
});
const url = `http://localhost:${(server.address() as AddressInfo).port}/api/lookup?ip=1.2.3.4`;

try {
  // 1. Unpaid request: 402 with an x402 offer (PAYMENT-REQUIRED) and an MPP challenge (WWW-Authenticate).
  const unpaid = await fetch(url);
  const challenge = unpaid.headers.get('www-authenticate') ?? '';
  console.log(`1. GET ${url} -> ${unpaid.status}`);
  console.log(`   PAYMENT-REQUIRED: ${unpaid.headers.has('payment-required') ? 'present (x402 offer)' : 'missing'}`);
  console.log(`   WWW-Authenticate: ${challenge.slice(0, 96)}…`);
  assert.equal(unpaid.status, 402);
  assert.match(challenge, /^Payment .*method="evm".*intent="charge"/);
  const request = JSON.parse(Buffer.from(/request="([^"]+)"/.exec(challenge)![1], 'base64url').toString());
  console.log(`   challenge request: ${JSON.stringify(request)}`);
  assert.equal(request.amount, '1000'); // 0.001 SBC, 6 decimals

  // 2. A buyer with a throwaway key pays over MPP: it signs an EIP-3009 authorization bound to the
  //    challenge and retries with `Authorization: Payment …`.
  const payFetch = createRadiusFetch({ network: 'testnet', signer: generatePrivateKey(), maxPerRequest: '0.01', protocols: ['mpp'] });
  const paid = await payFetch(url);
  const body = await paid.json();
  const receipt = getPaymentReceipt(paid, radiusTestnet);
  console.log(`2. paid retry from ${payFetch.address} -> ${paid.status}`);
  console.log(`   body: ${JSON.stringify(body)}`);
  console.log(`   Payment-Receipt: ${JSON.stringify(receipt)}`);
  assert.equal(paid.status, 200);
  assert.equal(body.paidWith, 'mpp');
  assert.equal(receipt?.protocol, 'mpp');

  // 3. The facilitator recovered the buyer from the signature, and the seller recorded one MPP settlement.
  console.log(`3. facilitator verified signer ${facilitator.verified[0]}; seller settled ${settled.length} payment(s) over ${settled[0]?.protocol}`);
  assert.deepEqual(facilitator.verified, [payFetch.address]);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].protocol, 'mpp');
  assert.equal(settled[0].transaction, receipt?.transaction);
  console.log('ok: MPP charge issued, paid and settled (local facilitator: nothing moved on chain)');
} finally {
  server.close();
}
