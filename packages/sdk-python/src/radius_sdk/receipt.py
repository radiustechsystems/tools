"""Decoded ``PAYMENT-RESPONSE`` (x402) or ``Payment-Receipt`` (MPP) headers: what was settled."""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Any, Literal

from .mpp import MPP_RECEIPT_HEADER, parse_mpp_receipt
from .networks import PaymentNetwork, explorer_tx_url

PAYMENT_RESPONSE_HEADER = "payment-response"
_ATOMIC_AMOUNT = re.compile(r"^[0-9]+$")


@dataclass
class PaymentReceipt:
    """What a payment settled: the transaction, network, payer and amount."""

    success: bool
    #: CAIP-2 network the settlement happened on.
    network: str
    #: Which protocol paid.
    protocol: Literal["x402", "mpp"] | None = None
    #: Settlement transaction hash (None when settlement failed).
    transaction: str | None = None
    payer: str | None = None
    #: Atomic amount charged. For ``exact`` this is the requested amount; facilitators only report it
    #: themselves for schemes (like ``upto``) where it can differ.
    amount: str | None = None
    error_reason: str | None = None
    error_message: str | None = None
    explorer_url: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """camelCase JSON, the shape the TypeScript SDK's ``PaymentReceipt`` has (unset fields left out)."""
        names = {"error_reason": "errorReason", "error_message": "errorMessage", "explorer_url": "explorerUrl"}
        return {names.get(k, k): v for k, v in asdict(self).items() if v is not None}


def parse_upto_settlement_amount(amount: Any, maximum: int) -> int:
    """Validate the amount a facilitator reports for an ``upto`` payment.

    It is an untrusted receipt field: it must be a non-negative integer string and must not exceed the
    maximum the payer signed.
    """
    if not isinstance(amount, str) or not _ATOMIC_AMOUNT.match(amount):
        raise ValueError("payment response: 'amount' must be a non-negative integer string")
    settled = int(amount)
    if settled > maximum:
        raise ValueError(f"payment response: settlement amount {settled} exceeds authorized maximum {maximum}")
    return settled


def decode_header_json(value: str) -> Any:
    """Base64 (standard or URL-safe, padding optional) JSON, as x402 headers carry it."""
    text = value.strip()
    padded = text + "=" * ((4 - len(text) % 4) % 4)
    try:
        raw = base64.b64decode(padded.replace("-", "+").replace("_", "/"), validate=True)
    except ValueError as e:
        raise ValueError(f"header is not base64: {e}") from e
    return json.loads(raw.decode("utf-8"))


def encode_header_json(value: Any) -> str:
    """Base64 JSON, as x402 headers carry it."""
    return base64.b64encode(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).decode(
        "ascii"
    )


def decode_payment_receipt(
    header_value: str, network: PaymentNetwork | None = None, expected_amount: str | None = None
) -> PaymentReceipt:
    """Decode a ``PAYMENT-RESPONSE`` header. Raises ValueError when it is not one."""
    r = decode_header_json(header_value)
    if not isinstance(r, dict):
        raise ValueError("payment response is not an object")
    amount = r.get("amount")
    if amount is not None and (not isinstance(amount, str) or not _ATOMIC_AMOUNT.match(amount)):
        raise ValueError("payment response: 'amount' must be a non-negative integer string")
    tx = r.get("transaction")
    transaction = tx if isinstance(tx, str) and tx else None
    success = r.get("success") is True

    def text(k: str) -> str | None:
        v = r.get(k)
        return v if isinstance(v, str) else None

    return PaymentReceipt(
        success=success,
        protocol="x402",
        transaction=transaction,
        network=text("network") or "",
        payer=text("payer"),
        amount=amount if isinstance(amount, str) else expected_amount if success else None,
        error_reason=text("errorReason"),
        error_message=text("errorMessage"),
        explorer_url=explorer_tx_url(network, transaction) if transaction and network else None,
    )


def decode_mpp_receipt(header_value: str, network: PaymentNetwork | None = None) -> PaymentReceipt:
    """Decode a ``Payment-Receipt`` (MPP). It names the transaction only; ``network`` fills in the network and explorer link."""
    r = parse_mpp_receipt(header_value)
    return PaymentReceipt(
        success=True,
        protocol="mpp",
        transaction=r.reference or None,
        network=network.network if network else "",
        explorer_url=explorer_tx_url(network, r.reference) if r.reference and network else None,
    )


def _header(source: Any, name: str) -> str | None:
    headers = getattr(source, "headers", source)
    if isinstance(headers, Mapping):
        # httpx.Headers and starlette Headers are case-insensitive mappings; a plain dict may not be.
        value = headers.get(name)
        if value is None:
            lowered = {str(k).lower(): v for k, v in headers.items()}
            value = lowered.get(name.lower())
        return value
    get = getattr(headers, "get", None)
    return get(name) if callable(get) else None


def get_payment_receipt(source: Any, network: PaymentNetwork | None = None) -> PaymentReceipt | None:
    """The payment receipt on a response (or its headers), if the server attached one.

    x402's ``PAYMENT-RESPONSE`` first, else MPP's ``Payment-Receipt`` (which names no payer or
    network; ``network`` fills the latter). Accepts an ``httpx.Response``, a Starlette ``Response``
    or any mapping of headers.
    """
    v = _header(source, PAYMENT_RESPONSE_HEADER) or _header(source, "x-payment-response")
    try:
        if v:
            return decode_payment_receipt(v, network)
        mpp = _header(source, MPP_RECEIPT_HEADER)
        return decode_mpp_receipt(mpp, network) if mpp else None
    except Exception:
        return None
