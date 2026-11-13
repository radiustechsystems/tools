// Pays the seller over MPP only, and prints the offer and the receipt.
//   RADIUS_PRIVATE_KEY=0x… pnpm buy [url]
// Against a seller run with MPP_LOCAL_FACILITATOR=1, leave RADIUS_PRIVATE_KEY unset: a throwaway
// key is generated, and no funds are needed. Add --fund to top a testnet key up from the faucet
// first (0.5 SBC, rate-limited per wallet).
import { generatePrivateKey } from 'viem/accounts';
import { createRadiusFetch, getPaymentReceipt, RadiusPaymentError } from 'radius-sdk/client';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--')) ?? 'http://localhost:8791/api/lookup?ip=1.2.3.4';
const key = (process.env.RADIUS_PRIVATE_KEY ?? generatePrivateKey()) as `0x${string}`;
if (!process.env.RADIUS_PRIVATE_KEY) console.error('RADIUS_PRIVATE_KEY not set: using an unfunded throwaway key (works only against MPP_LOCAL_FACILITATOR=1)');

const payFetch = createRadiusFetch({
  network: 'testnet',
  signer: key,
  maxPerRequest: '0.01',
  protocols: ['mpp'], // the seller offers x402 and MPP; pay over MPP only
  onPaymentRequired: (offer) => {
    console.error(`offer: ${offer.amountFormatted} to ${offer.payTo} over ${offer.protocol} for ${offer.resource.url}`);
    return true;
  },
});
console.error(`payer ${payFetch.address}`);

if (args.includes('--fund')) {
  const funded = await payFetch.fund();
  console.error(`faucet: ${funded.amount} SBC, tx ${funded.txHash}`);
}

try {
  const res = await payFetch(url);
  console.error(`HTTP ${res.status}, Payment-Receipt ${res.headers.get('payment-receipt') ? 'present' : 'missing'}`);
  console.log(await res.text());
  console.error('receipt:', getPaymentReceipt(res, payFetch.network));
  if (!res.ok) process.exit(1);
} catch (e) {
  if (!(e instanceof RadiusPaymentError)) throw e;
  console.error(`payment error [${e.code}]: ${e.message}`);
  process.exit(2);
}
