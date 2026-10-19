"""Prices and amounts: USD display strings to atomic integers and back, with no floating point math."""

from __future__ import annotations

import re
from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Protocol, TypedDict, Union

Price = Union[str, int, float, Decimal, Mapping[str, Any]]
"""A price. Strings and numbers are USD (SBC is USD-pegged): "$0.01", "0.01", "0.01 SBC", 0.01.
A mapping ``{"amount": "10000"}`` is an atomic amount in the asset's base units, optionally naming a
different ERC-20 ``asset``."""


class AtomicAmount(TypedDict):
    amount: str
    asset: str


class _Asset(Protocol):
    @property
    def address(self) -> str: ...

    @property
    def decimals(self) -> int: ...


_DECIMAL = re.compile(r"^[0-9]+(\.[0-9]+)?$")
_INTEGER = re.compile(r"^[0-9]+$")
_PREFIX_UNIT = re.compile(r"^(usd|sbc)\s+", re.IGNORECASE)
_SUFFIX_UNIT = re.compile(r"\s+(usd|sbc)$", re.IGNORECASE)


def _number_text(price: int | float | Decimal) -> str:
    if isinstance(price, bool):
        raise ValueError(f"to_atomic: invalid price {price!r}")
    if isinstance(price, Decimal):
        if not price.is_finite() or price < 0:
            raise ValueError(f"to_atomic: invalid price {price}")
        text = format(price, "f")
    elif isinstance(price, int):
        if price < 0:
            raise ValueError(f"to_atomic: invalid price {price}")
        text = str(price)
    elif isinstance(price, float):
        if price != price or price in (float("inf"), float("-inf")) or price < 0:
            raise ValueError(f"to_atomic: invalid price {price}")
        text = repr(price)
        if "e" in text.lower():
            raise ValueError(f"to_atomic: price {price} is not representable as a plain decimal; pass a string")
        if text.endswith(".0"):
            text = text[:-2]
    else:
        raise ValueError(f"to_atomic: cannot parse price '{price}'")
    return text


def to_atomic(price: str | int | float | Decimal, decimals: int) -> str:
    """Convert a display-unit price to an atomic integer string. No floating point math."""
    if isinstance(price, str):
        s = price.strip()
        # Accept "$0.01", "0.01 SBC", "0.01 USD", "USD 0.01"
        s = s.removeprefix("$")
        s = _PREFIX_UNIT.sub("", s)
        s = _SUFFIX_UNIT.sub("", s)
        s = s.removeprefix("$")
    else:
        s = _number_text(price)
    if not _DECIMAL.match(s):
        raise ValueError(f"to_atomic: cannot parse price '{price}'")
    whole, _, frac = s.partition(".")
    if len(frac) > decimals:
        raise ValueError(f"to_atomic: price '{price}' has more than {decimals} decimal places")
    return str(int(whole + frac.ljust(decimals, "0")))


def format_amount(atomic: str | int, decimals: int, symbol: str | None = None) -> str:
    """Format an atomic amount as a decimal string, e.g. 10000 → "0.01"."""
    v = int(atomic)
    neg = v < 0
    s = str(-v if neg else v).rjust(decimals + 1, "0")
    whole = s[: len(s) - decimals]
    frac = s[len(s) - decimals :].rstrip("0") if decimals else ""
    out = f"{'-' if neg else ''}{whole}{'.' + frac if frac else ''}"
    return f"{out} {symbol}" if symbol else out


def resolve_price(price: Price, asset: _Asset) -> AtomicAmount:
    """Resolve a :data:`Price` to its atomic ``{"amount", "asset"}`` form."""
    if isinstance(price, Mapping):
        raw = price.get("amount")
        amount = str(raw) if isinstance(raw, int) and not isinstance(raw, bool) else raw
        if not isinstance(amount, str) or not _INTEGER.match(amount):
            raise ValueError(f"resolve_price: atomic amount must be an integer string (got '{amount}')")
        return {"amount": amount, "asset": price.get("asset") or asset.address}
    return {"amount": to_atomic(price, asset.decimals), "asset": asset.address}
