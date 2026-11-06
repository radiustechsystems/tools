// A stand-in for the Radius facilitator, for running the example without testnet funds. It checks
// what the real facilitator checks before it settles (the EIP-3009 signature, recipient, amount and
// validity window, and that the nonce is unused), then returns a made-up transaction hash instead
// of sending `transferWithAuthorization` on chain. Nothing moves; never use it to sell anything.
import { keccak256, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { radiusTestnet } from 'radius-sdk';
import { staticSupported, type FacilitatorClient } from 'radius-sdk/server';

type Payload = Parameters<FacilitatorClient['verify']>[0];
type Requirements = Parameters<FacilitatorClient['verify']>[1];
type Authorization = { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };

const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export function localFacilitator(): FacilitatorClient & { verified: Address[] } {
  const usedNonces = new Set<string>();
  const verified: Address[] = [];

  async function check(payload: Payload, requirements: Requirements): Promise<{ payer?: Address; reason?: string }> {
    const { authorization: a, signature } = payload.payload as { authorization?: Authorization; signature?: Hex };
    if (!a || !signature) return { reason: 'not an EIP-3009 authorization' };
    if (requirements.network !== radiusTestnet.network) return { reason: `unsupported network ${requirements.network}` };
    if (a.to.toLowerCase() !== requirements.payTo.toLowerCase()) return { reason: 'wrong recipient' };
    if (a.value !== requirements.amount) return { reason: 'wrong amount' };
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(a.validAfter) > now || BigInt(a.validBefore) <= now) return { reason: 'outside the validity window' };
    if (usedNonces.has(a.nonce.toLowerCase())) return { reason: 'nonce already used' };
    const extra = requirements.extra as { name: string; version: string };
    const signer = await recoverTypedDataAddress({
      domain: { name: extra.name, version: extra.version, chainId: radiusTestnet.chainId, verifyingContract: requirements.asset as Address },
      types: TRANSFER_WITH_AUTHORIZATION,
      primaryType: 'TransferWithAuthorization',
      message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
      signature,
    });
    if (signer.toLowerCase() !== a.from.toLowerCase()) return { reason: 'signature is not from the payer' };
    return { payer: a.from };
  }

  return {
    verified,
    async getSupported() {
      return staticSupported(radiusTestnet);
    },
    async verify(payload, requirements) {
      const { payer, reason } = await check(payload, requirements);
      return payer ? { isValid: true, payer } : { isValid: false, invalidReason: 'invalid_payload', invalidMessage: reason };
    },
    async settle(payload, requirements) {
      const { payer, reason } = await check(payload, requirements);
      if (!payer) return { success: false, errorReason: 'invalid_payload', errorMessage: reason, transaction: '', network: requirements.network };
      const { authorization, signature } = payload.payload as { authorization: Authorization; signature: Hex };
      usedNonces.add(authorization.nonce.toLowerCase());
      verified.push(payer);
      // Not a real transaction: the hash of the signature, so each payment gets a distinct one.
      return { success: true, transaction: keccak256(signature), network: requirements.network, payer };
    },
  };
}
