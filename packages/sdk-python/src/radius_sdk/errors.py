"""The one error type the SDK raises for payment decisions, with a machine-readable ``code``."""

from __future__ import annotations

from typing import Any, Literal

RadiusPaymentErrorCode = Literal[
    "no_compatible_offer",
    "network_mismatch",
    "asset_mismatch",
    "price_above_limit",
    "insufficient_balance",
    "declined",
    "invalid_challenge",
    "payment_rejected",
    "invalid_receipt",
    "redirect_refused",
    "settle_failed",
    "facilitator_unreachable",
    "unsupported_transfer_method",
    "approval_required",
    "approval_failed",
    "faucet",
    "config",
]


class RadiusPaymentError(Exception):
    """A payment the SDK refused, could not make, or that the server rejected.

    ``code`` says which (the same codes as the TypeScript SDK); ``details`` carries what the decision
    was made on: the offers, the server's response, the approval request.
    """

    def __init__(self, code: RadiusPaymentErrorCode, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.code: RadiusPaymentErrorCode = code
        self.message = message
        self.details = details

    def __repr__(self) -> str:
        return f"RadiusPaymentError({self.code!r}, {self.message!r})"
