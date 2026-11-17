// Runs the seller on Node. Testnet by default, settled by the Radius testnet facilitator.
//   PAY_TO=0x… MPP_SECRET_KEY="$(openssl rand -base64 32)" pnpm seller
// MPP_LOCAL_FACILITATOR=1 settles through ./local-facilitator.ts instead: nothing moves on chain,
// so an unfunded throwaway buyer can pay.
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { createSeller } from './app.ts';
import { localFacilitator } from './local-facilitator.ts';

const PAY_TO = (process.env.PAY_TO ?? '0x1eF420190c299D4d133fE9227F780D7d5cE91BeE') as `0x${string}`;
const PORT = Number(process.env.PORT ?? 8791);
const LOCAL = process.env.MPP_LOCAL_FACILITATOR === '1';

let secret = process.env.MPP_SECRET_KEY;
if (!secret) {
  // Fine for one process; challenges stop verifying after a restart or on another instance.
  secret = randomBytes(32).toString('base64');
  console.error('MPP_SECRET_KEY not set: using a random key for this process');
}

const fetch = createSeller({
  payTo: PAY_TO,
  mppSecretKey: secret,
  ...(LOCAL && { facilitator: localFacilitator() }),
  onSettled: (r) => console.log(`settled over ${r.protocol}: ${r.amount} atomic SBC from ${r.payer}, tx ${r.transaction}${LOCAL ? ' (local, not on chain)' : ''}`),
});

serve({ fetch, port: PORT }, () =>
  console.log(`radius-mpp-example seller on http://localhost:${PORT} (testnet, pay to ${PAY_TO}, ${LOCAL ? 'local facilitator: nothing settles on chain' : 'Radius testnet facilitator'})`),
);
