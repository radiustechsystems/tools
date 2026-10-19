"""What :func:`radius_sdk.client.create_radius_fetch` can pay."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class SupportedScheme:
    """One x402 scheme/version combination the client can pay."""

    x402_version: Literal[1, 2]
    scheme: Literal["exact", "upto"]
    #: ``assetTransferMethod`` values accepted for this scheme.
    transfer_methods: tuple[Literal["permit2", "eip3009"], ...]


#: What the client can pay, in the order offers are preferred.
SUPPORTED_SCHEMES: tuple[SupportedScheme, ...] = (
    SupportedScheme(2, "exact", ("permit2", "eip3009")),
    SupportedScheme(2, "upto", ("permit2",)),
    SupportedScheme(1, "exact", ("eip3009",)),
)


def describe_supported_schemes() -> str:
    """Human-readable summary, e.g. "exact@v2 (permit2 or eip3009), upto@v2 (permit2), exact@v1 (eip3009)"."""
    return ", ".join(f"{s.scheme}@v{s.x402_version} ({' or '.join(s.transfer_methods)})" for s in SUPPORTED_SCHEMES)
