// A TypeScript-SDK buyer for the Python interop tests: createRadiusFetch() pays the URL and prints what happened.
// Usage: node ts_buyer.mjs '<json options>' → prints {"status", "body", "receipt", "offer", "sent"} as JSON.
import { createRadiusFetch, getPaymentReceipt, RadiusPaymentError } from '../../../sdk/dist/client/index.js';
import { resolveNetwork } from '../../../sdk/dist/index.js';

const opts = JSON.parse(process.argv[2]);
const network = resolveNetwork(opts.network ?? 'testnet', { rpcUrl: opts.rpcUrl ?? 'http://127.0.0.1:1' });
const sent = [];
const baseFetch = async (input, init) => {
  const request = new Request(input, init);
  sent.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers) });
  return fetch(request);
};
let offer;
const pay = createRadiusFetch({
  network,
  signer: opts.privateKey,
  maxPerRequest: opts.maxPerRequest ?? '$0.05',
  protocols: opts.protocols,
  fetch: baseFetch,
  onPaymentRequired: (o) => { offer = { protocol: o.protocol, scheme: o.scheme, amount: o.amount, payTo: o.payTo, transferMethod: o.transferMethod, x402Version: o.x402Version }; return true; },
});
try {
  const res = await pay(opts.url, opts.init);
  const text = await res.text();
  process.stdout.write(JSON.stringify({ status: res.status, body: text, receipt: getPaymentReceipt(res, network) ?? null, offer: offer ?? null, sent }) + '\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e instanceof RadiusPaymentError ? e.code : String(e), message: e.message, offer: offer ?? null, sent }) + '\n');
}
