"""Server-side ``exact`` scheme for one network, for the x402 resource server."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal, Union

from x402.schemas import AssetAmount, PaymentRequirements, SupportedKind

from ..amounts import resolve_price
from ..networks import PaymentNetwork

SettleMode = Literal["before", "after"]
GasSponsoringMode = Union[Literal["auto"], bool]
"""``auto``: declare gas sponsoring iff the facilitator's ``/supported`` lists it."""

EIP2612_GAS_SPONSORING = "eip2612GasSponsoring"


class RadiusExactScheme:
    """``exact`` for one network: prices in USD or its asset's atomic units, Permit2 or EIP-3009.

    No EVM dependency (the facilitator does all the cryptography). The transfer method is whichever
    the facilitator lists first for the network, else EIP-3009 (x402's default, and what Base
    facilitators settle for USDC).
    """

    scheme = "exact"
    default_asset_transfer_method = "eip3009"
    #: ``paymentFlow`` is a server-side hint (when to settle relative to the handler). Clients are not
    #: required to echo it, so it is excluded from accepted-vs-required matching: stock radius-cli
    #: only echoes assetTransferMethod/name/version.
    dynamic_extra_fields = ["paymentFlow"]

    def __init__(
        self, network: PaymentNetwork, settle: SettleMode = "before", gas_sponsoring: GasSponsoringMode = "auto"
    ) -> None:
        self.network = network
        self.gas_sponsoring = gas_sponsoring
        # Both transfer methods a facilitator may list; the one it names first for the network is
        # what the 402 advertises.
        flows = {
            "supported": ["authorization", "upfront"],
            "default": "upfront" if settle == "before" else "authorization",
        }
        self.payment_flows = {"permit2": flows, "eip3009": flows}
        #: Extensions the facilitator's last ``/supported`` listed (set by the server's scoped facilitator).
        self.facilitator_extensions: list[str] | None = None
        #: Schemes of every network the server offers (this one included). The gas-sponsoring declaration is
        #: shared by all offers in a 402, so it stays while any of them declares it.
        self.peers: Sequence[RadiusExactScheme] = (self,)

    def parse_price(self, price: Any, network: str) -> AssetAmount:
        if isinstance(price, AssetAmount):  # the routes resolve prices to atomic amounts up front
            price = {"amount": price.amount, "asset": price.asset}
        resolved = resolve_price(price, self.network.asset)
        return AssetAmount(amount=resolved["amount"], asset=resolved["asset"], extra={})

    def enhance_payment_requirements(
        self, requirements: PaymentRequirements, supported_kind: SupportedKind, extensions: list[str]
    ) -> PaymentRequirements:
        kind_extra = supported_kind.extra or {}
        extra = {
            "assetTransferMethod": kind_extra.get("assetTransferMethod", "eip3009"),
            "name": kind_extra.get("name", self.network.asset.name),
            "version": kind_extra.get("version", self.network.asset.version),
            **(requirements.extra or {}),
        }
        return requirements.model_copy(update={"extra": extra})

    def declares_gas_sponsoring(self) -> bool:
        """True when 402 responses should declare ``eip2612GasSponsoring``."""
        if self.gas_sponsoring != "auto":
            return bool(self.gas_sponsoring)
        return (
            EIP2612_GAS_SPONSORING in self.facilitator_extensions if self.facilitator_extensions is not None else True
        )

    def enrich_payment_required_response(self, context: Any) -> None:
        """Strip the static gas-sponsoring declaration when no offered network's facilitator supports it.

        Clients then fall back to a normal Permit2 approval instead of sending a permit nobody will honour.
        """
        response = context.payment_required_response
        ext = response.extensions
        if ext and EIP2612_GAS_SPONSORING in ext and not any(p.declares_gas_sponsoring() for p in self.peers):
            rest = {k: v for k, v in ext.items() if k != EIP2612_GAS_SPONSORING}
            response.extensions = rest or None
        return None
