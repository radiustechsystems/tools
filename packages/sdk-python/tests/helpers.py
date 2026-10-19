"""Shared test doubles: an in-process facilitator that checks signatures, and in-process ASGI transports."""

from __future__ import annotations

import base64
import json
from typing import Any

import httpx
from eth_account import Account
from eth_account.messages import encode_typed_data
from x402.schemas import SettleResponse, SupportedResponse, VerifyResponse

PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
SIGNER = Account.from_key(PK)
PAY_TO = "0x000000000000000000000000000000000000dEaD"
TX_HASH = "0x" + "ab" * 32

EIP3009_TYPES = {
    "TransferWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ]
}
PERMIT2_EXACT_TYPES = {
    "PermitWitnessTransferFrom": [
        {"name": "permitted", "type": "TokenPermissions"},
        {"name": "spender", "type": "address"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint256"},
        {"name": "witness", "type": "Witness"},
    ],
    "TokenPermissions": [{"name": "token", "type": "address"}, {"name": "amount", "type": "uint256"}],
    "Witness": [{"name": "to", "type": "address"}, {"name": "validAfter", "type": "uint256"}],
}
PERMIT2_UPTO_TYPES = {
    **PERMIT2_EXACT_TYPES,
    "Witness": [
        {"name": "to", "type": "address"},
        {"name": "facilitator", "type": "address"},
        {"name": "validAfter", "type": "uint256"},
    ],
}
PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3"


def b64(value: Any) -> str:
    return base64.b64encode(json.dumps(value).encode()).decode()


def from_b64(value: str) -> Any:
    return json.loads(base64.b64decode(value))


def recover(
    domain: dict[str, Any], types: dict[str, Any], primary: str, message: dict[str, Any], signature: str
) -> str:
    full = {
        "types": {"EIP712Domain": _domain_fields(domain), **types},
        "primaryType": primary,
        "domain": domain,
        "message": message,
    }
    return Account.recover_message(encode_typed_data(full_message=full), signature=signature)


def _domain_fields(domain: dict[str, Any]) -> list[dict[str, str]]:
    order = [("name", "string"), ("version", "string"), ("chainId", "uint256"), ("verifyingContract", "address")]
    return [{"name": k, "type": t} for k, t in order if k in domain]


def recover_eip3009(chain_id: int, asset: str, name: str, version: str, payload: dict[str, Any]) -> str:
    a = payload["authorization"]
    message = {
        "from": a["from"],
        "to": a["to"],
        "value": int(a["value"]),
        "validAfter": int(a["validAfter"]),
        "validBefore": int(a["validBefore"]),
        "nonce": a["nonce"],
    }
    domain = {"name": name, "version": version, "chainId": chain_id, "verifyingContract": asset}
    return recover(domain, EIP3009_TYPES, "TransferWithAuthorization", message, payload["signature"])


class MockFacilitator:
    """A facilitator that recovers EIP-3009 signers and records calls. ``supported`` mirrors the Radius facilitator."""

    def __init__(
        self, network: Any, *, extensions: list[str] | None = None, methods: tuple[str, ...] = ("eip3009", "permit2")
    ) -> None:
        self.network = network
        self.extensions = ["eip2612GasSponsoring"] if extensions is None else extensions
        self.methods = methods
        self.verified: list[tuple[Any, Any]] = []
        self.settled: list[tuple[Any, Any]] = []
        self.verify_error: Exception | None = None
        self.settle_error: Exception | None = None
        self.settle_success = True
        self.supported_calls = 0

    def get_supported(self) -> SupportedResponse:
        self.supported_calls += 1
        return SupportedResponse.model_validate(
            {
                "kinds": [
                    {
                        "x402Version": 2,
                        "scheme": "exact",
                        "network": self.network.network,
                        "extra": {
                            "assetTransferMethod": m,
                            "name": self.network.asset.name,
                            "version": self.network.asset.version,
                        },
                    }
                    for m in self.methods
                ],
                "extensions": self.extensions,
                "signers": {},
            }
        )

    async def verify(self, payload: Any, requirements: Any) -> VerifyResponse:
        if self.verify_error:
            raise self.verify_error
        self.verified.append((payload, requirements))
        inner = payload.payload
        if "authorization" in inner:
            extra = requirements.extra or {}
            signer = recover_eip3009(self.network.chain_id, requirements.asset, extra["name"], extra["version"], inner)
            if signer.lower() != inner["authorization"]["from"].lower():
                return VerifyResponse(is_valid=False, invalid_reason="invalid_signature")
            return VerifyResponse(is_valid=True, payer=signer)
        return VerifyResponse(is_valid=True, payer=inner["permit2Authorization"]["from"])

    async def settle(self, payload: Any, requirements: Any) -> SettleResponse:
        if self.settle_error:
            raise self.settle_error
        self.settled.append((payload, requirements))
        inner = payload.payload
        payer = (inner.get("authorization") or inner.get("permit2Authorization") or {}).get("from")
        if not self.settle_success:
            return SettleResponse(
                success=False,
                error_reason="insufficient_funds",
                transaction="",
                network=requirements.network,
                payer=payer,
            )
        return SettleResponse(success=True, transaction=TX_HASH, network=requirements.network, payer=payer)


def asgi_client(app: Any, base_url: str = "http://shop.test") -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=base_url)
