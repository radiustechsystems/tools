import { afterEach, describe, expect, it, vi } from 'vitest';
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, SupportedResponse } from '@x402/core/types';
import { radiusMainnet, radiusTestnet } from '../src/networks.js';
import { RadiusExactScheme, assertRadiusSupported, radiusFacilitators, registerRadius, type RadiusRegistration } from '../src/server/index.js';

const PAY_TO = '0x1eF420190c299D4d133fE9227F780D7d5cE91BeE';
const BASE_KIND = { x402Version: 2, scheme: 'exact', network: 'eip155:8453', extra: {} };

/** Radius networks with the built-in `/supported` answer, so nothing is fetched until verify/settle. */
const offline = (settle: RadiusRegistration['settle']): RadiusRegistration => ({
  settle,
  networks: [
    { network: 'mainnet', facilitator: { live: false } },
    { network: 'testnet', facilitator: { live: false } },
  ],
});

/** A caller's own facilitator for Base, optionally also (wrongly) claiming Radius testnet. */
function otherFacilitator(extraKinds: SupportedResponse['kinds'] = []) {
  const f = {
    verify: vi.fn(async () => ({ isValid: true })),
    settle: vi.fn(async () => ({ success: true, transaction: '0x1', network: BASE_KIND.network })),
    getSupported: vi.fn(async () => ({ kinds: [BASE_KIND, ...extraKinds], extensions: [], signers: {} })),
  };
  return f as typeof f & FacilitatorClient;
}

function requirements(network: string): PaymentRequirements {
  return { scheme: 'exact', network, asset: radiusTestnet.asset.address, amount: '1000', payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { assetTransferMethod: 'eip3009' } } as PaymentRequirements;
}
const payloadFor = (r: PaymentRequirements) => ({ x402Version: 2, accepted: r, payload: {} }) as unknown as PaymentPayload;

function mockRadiusFacilitator() {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.endsWith('/verify')) return Response.json({ isValid: true, payer: '0xabc' });
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('adding Radius to an existing x402 resource server', () => {
  it('registers the scheme for each network, with the settle mode that was asked for', () => {
    const server = registerRadius(new x402ResourceServer(), offline('after'));
    for (const network of [radiusMainnet, radiusTestnet]) {
      const scheme = server.getRegisteredScheme(network.network, 'exact');
      expect(scheme).toBeInstanceOf(RadiusExactScheme);
      expect((scheme as RadiusExactScheme).settle).toBe('after');
    }
  });

  it('defaults to Radius mainnet and returns the server it was given', () => {
    const server = new x402ResourceServer();
    expect(registerRadius(server, { settle: 'before' })).toBe(server);
    expect(server.getRegisteredScheme(radiusMainnet.network, 'exact')).toBeInstanceOf(RadiusExactScheme);
    expect(server.getRegisteredScheme(radiusTestnet.network, 'exact')).toBeUndefined();
  });

  it('returns one facilitator per network, each reporting only its own network', async () => {
    const facilitators = radiusFacilitators(offline('after'));
    expect(facilitators).toHaveLength(2);
    const reported = await Promise.all(facilitators.map(async (f) => (await f.getSupported()).kinds.map((k) => k.network)));
    expect(reported.map((networks) => new Set(networks))).toEqual([new Set([radiusMainnet.network]), new Set([radiusTestnet.network])]);
  });

  it('routes Radius to its facilitator even when the other one also lists the network', async () => {
    const calls = mockRadiusFacilitator();
    const other = otherFacilitator([{ ...BASE_KIND, network: radiusTestnet.network }]);
    const options = offline('after');
    const server = registerRadius(new x402ResourceServer([...radiusFacilitators(options), other]), options);
    await server.initialize();
    assertRadiusSupported(server, options);

    const r = requirements(radiusTestnet.network);
    await expect(server.verifyPayment(payloadFor(r), r)).resolves.toMatchObject({ isValid: true, payer: '0xabc' });
    expect(calls).toEqual([`${radiusTestnet.facilitatorUrl}/verify`]);
    expect(other.verify).not.toHaveBeenCalled();
  });

  it('fails the startup check when no facilitator reports a network', async () => {
    const options = offline('after');
    const server = registerRadius(new x402ResourceServer(otherFacilitator()), options);
    await server.initialize();
    expect(() => assertRadiusSupported(server, options)).toThrow(/no facilitator reported supporting exact payments on radius \(eip155:723487\)/);
  });
});

describe('settle mode and the /verify call', () => {
  // `settle: 'before'` is the default of radiusPayments(); core then skips /verify. This pins what
  // a caller-owned pipeline gets from each mode, so the difference cannot change unnoticed.
  async function verify(settle: RadiusRegistration['settle']) {
    const calls = mockRadiusFacilitator();
    const options: RadiusRegistration = { settle, networks: [{ network: 'testnet', facilitator: { live: false } }] };
    const server = registerRadius(new x402ResourceServer(radiusFacilitators(options)), options);
    await server.initialize();
    const r = requirements(radiusTestnet.network);
    return { calls, result: await server.verifyPayment(payloadFor(r), r) };
  }

  it("'after' calls the facilitator's /verify before the handler", async () => {
    const { calls, result } = await verify('after');
    expect(calls).toEqual([`${radiusTestnet.facilitatorUrl}/verify`]);
    expect(result).toMatchObject({ isValid: true, payer: '0xabc' });
  });

  it("'before' skips /verify and answers isValid without checking the payment", async () => {
    const { calls, result } = await verify('before');
    expect(calls).toEqual([]);
    expect(result).toEqual({ isValid: true });
  });

  it("advertises 'upfront' for 'before' and 'authorization' for 'after'", () => {
    expect(new RadiusExactScheme(radiusTestnet, 'before').paymentFlows.eip3009.default).toBe('upfront');
    expect(new RadiusExactScheme(radiusTestnet, 'after').paymentFlows.eip3009.default).toBe('authorization');
  });

  it("warns once when a scheme is built without a settle mode, then keeps the 'before' default", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scheme = new RadiusExactScheme(radiusTestnet);
    new RadiusExactScheme(radiusTestnet);
    expect(scheme.settle).toBe('before');
    expect(scheme.paymentFlows.eip3009.default).toBe('upfront');
    expect(warn.mock.calls.filter(([m]) => String(m).includes('RadiusExactScheme defaults settle'))).toHaveLength(1);
    new RadiusExactScheme(radiusTestnet, 'after');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
