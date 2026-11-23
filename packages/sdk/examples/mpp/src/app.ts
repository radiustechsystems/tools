// The seller: one free route and one priced route. `mpp: { secretKey }` makes every 402 carry an
// MPP challenge (`WWW-Authenticate: Payment … method="evm", intent="charge"`) next to the x402
// offer, and settles an MPP credential through the same facilitator as an x402 payment.
import { radiusPayments, type FacilitatorClient } from 'radius-sdk/server';
import type { PaymentReceipt } from 'radius-sdk';

export interface SellerOptions {
  payTo: `0x${string}`;
  /** At least 32 random characters (`openssl rand -base64 32`), the same on every instance. */
  mppSecretKey: string;
  /** Default: the Radius testnet facilitator. The demo passes a local one. */
  facilitator?: FacilitatorClient;
  onSettled?: (receipt: PaymentReceipt) => void;
}

export function createSeller({ payTo, mppSecretKey, facilitator, onSettled }: SellerOptions): (request: Request) => Promise<Response> {
  const pay = radiusPayments({
    network: 'testnet',
    ...(facilitator && { facilitator }),
    payTo,
    routes: {
      'GET /api/lookup': { price: '0.001 SBC', description: 'Reputation lookup for one IP address' },
    },
    mpp: { secretKey: mppSecretKey },
    onSettled: (receipt) => onSettled?.(receipt),
  });

  return pay.wrap((request, payment) => {
    const url = new URL(request.url);
    if (url.pathname === '/') return Response.json({ ok: true, paid: ['GET /api/lookup?ip=…  0.001 SBC (x402 or MPP)'] });
    if (url.pathname === '/api/lookup') {
      // Runs only after the payment settled (settle defaults to 'before'); `payment.protocol` is 'mpp' or 'x402'.
      const ip = url.searchParams.get('ip') ?? '0.0.0.0';
      return Response.json({ ip, reputation: ip.startsWith('10.') ? 'private' : 'clean', score: 7, paidWith: payment?.protocol, payer: payment?.payer });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  });
}
