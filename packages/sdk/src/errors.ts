export type RadiusPaymentErrorCode =
  | 'no_compatible_offer'
  | 'network_mismatch'
  | 'asset_mismatch'
  | 'price_above_limit'
  | 'insufficient_balance'
  | 'declined'
  | 'invalid_challenge'
  | 'payment_rejected'
  | 'invalid_receipt'
  | 'redirect_refused'
  | 'settle_failed'
  | 'facilitator_unreachable'
  | 'unsupported_transfer_method'
  | 'approval_required'
  | 'approval_failed'
  | 'faucet'
  | 'signer_unavailable'
  | 'config';

export class RadiusPaymentError extends Error {
  readonly code: RadiusPaymentErrorCode;
  readonly details?: unknown;
  constructor(code: RadiusPaymentErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'RadiusPaymentError';
    this.code = code;
    this.details = details;
  }
}
