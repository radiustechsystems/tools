"""Port of the TypeScript SDK's ``client-parity.test.ts`` (itself ported from radius-cli): header names, decoded
payload shape, and EIP-712 signatures that recover to the signer. Nothing touches the network: sellers and JSON-RPC
are httpx mock transports."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from helpers import (
    EIP3009_TYPES,
    PERMIT2_ADDRESS,
    PERMIT2_EXACT_TYPES,
    PERMIT2_UPTO_TYPES,
    PK,
    SIGNER,
    b64,
    from_b64,
    recover,
)
from radius_sdk import X402_EXACT_PERMIT2_PROXY, NetworkOverrides, get_payment_receipt, resolve_network
from radius_sdk.client import ApprovalRequest, InvalidChallengeDetails, PaymentRejectedDetails, create_radius_fetch
from radius_sdk.errors import RadiusPaymentError

ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
PAY_TO = "0x000000000000000000000000000000000000dEaD"
FACILITATOR = "0x00000000000000000000000000000000fac11107"
X402_UPTO_PERMIT2_PROXY = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002"
CHAIN_ID = 84532
NETWORK_ID = f"eip155:{CHAIN_ID}"
RESOURCE_URL = "https://api.example.com/r"
MAX_UINT256 = 2**256 - 1

# The CLI tests' chain 84532 / USDC is the Base Sepolia preset; the RPC is a mock transport.
NETWORK = resolve_network("base-sepolia", NetworkOverrides(rpc_url="http://rpc.test"))
PERMIT2_DOMAIN = {"name": "Permit2", "chainId": CHAIN_ID, "verifyingContract": PERMIT2_ADDRESS}
USDC_DOMAIN = {"name": "USDC", "version": "2", "chainId": CHAIN_ID, "verifyingContract": ASSET}

EXACT_EIP3009 = {
    "scheme": "exact",
    "network": NETWORK_ID,
    "asset": ASSET,
    "payTo": PAY_TO,
    "amount": "13000",
    "maxTimeoutSeconds": 120,
    "extra": {"name": "USDC", "version": "2", "assetTransferMethod": "eip3009"},
}
EXACT_PERMIT2 = {**EXACT_EIP3009, "extra": {"name": "USDC", "version": "2", "assetTransferMethod": "permit2"}}
UPTO = {
    "scheme": "upto",
    "network": NETWORK_ID,
    "asset": ASSET,
    "payTo": PAY_TO,
    "amount": "500000",
    "maxTimeoutSeconds": 120,
    "extra": {"name": "USDC", "version": "2", "facilitatorAddress": FACILITATOR},
}
V1_EXACT = {
    "x402Version": 1,
    "accepts": [
        {
            "scheme": "exact",
            "network": NETWORK_ID,
            "asset": ASSET,
            "payTo": PAY_TO,
            "maxAmountRequired": "13000",
            "resource": "/example",
            "description": "access fee",
            "mimeType": "application/json",
            "maxTimeoutSeconds": 60,
            "extra": {"name": "USDC", "version": "2"},
        }
    ],
    "error": "X-PAYMENT required",
}


def v2(accept: dict[str, Any], extensions: dict[str, Any] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"x402Version": 2, "resource": {"url": RESOURCE_URL, "description": "r"}, "accepts": [accept]}
    if extensions:
        out["extensions"] = extensions
    return out


def ok(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"ok": True})


class Seller:
    """Answers unpaid requests with ``challenge`` (v2: header, v1: body) and paid ones with ``paid``."""

    def __init__(
        self, challenge: Any, paid: Callable[[httpx.Request], httpx.Response] = ok, *, in_body: bool = False
    ) -> None:
        self.challenge = challenge
        self.paid = paid
        self.in_body = in_body
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if "payment-signature" in request.headers or "x-payment" in request.headers:
            return self.paid(request)
        if self.challenge.get("x402Version") == 2 and not self.in_body:
            return httpx.Response(402, headers={"PAYMENT-REQUIRED": b64(self.challenge)})
        return httpx.Response(402, json=self.challenge)


def receipt_response(receipt: dict[str, Any], status: int = 200) -> Callable[[httpx.Request], httpx.Response]:
    return lambda _r: httpx.Response(status, json={"ok": True}, headers={"PAYMENT-RESPONSE": b64(receipt)})


class Rpc:
    """JSON-RPC stub: allowance(address,address) and nonces(address) answer from the fields; nothing else is stubbed."""

    def __init__(self, allowance: int = MAX_UINT256, nonce: int = 0, allowance_error: bool = False) -> None:
        self.allowance = allowance
        self.nonce = nonce
        self.allowance_error = allowance_error
        self.calls: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        method = body["method"]
        self.calls.append(method)
        if method == "eth_chainId":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": hex(CHAIN_ID)})
        if method == "eth_call":
            selector = body["params"][0].get("data", "")[:10]
            if self.allowance_error and selector == "0xdd62ed3e":
                return httpx.Response(
                    200,
                    json={
                        "jsonrpc": "2.0",
                        "id": body["id"],
                        "error": {"code": -32000, "message": "allowance read failed"},
                    },
                )
            value = self.allowance if selector == "0xdd62ed3e" else self.nonce if selector == "0x7ecebe00" else 0
            return httpx.Response(
                200, json={"jsonrpc": "2.0", "id": body["id"], "result": "0x" + hex(value)[2:].rjust(64, "0")}
            )
        return httpx.Response(
            200, json={"jsonrpc": "2.0", "id": body["id"], "error": {"code": -32601, "message": f"unstubbed {method}"}}
        )


def buyer(handler: Callable[[httpx.Request], httpx.Response], rpc: Rpc | None = None, **extra: Any) -> Any:
    options: dict[str, Any] = {
        "network": NETWORK,
        "signer": PK,
        "max_per_request": {"amount": "1000000"},
        "http_client": httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        "rpc_http_client": httpx.AsyncClient(transport=httpx.MockTransport(rpc or Rpc())),
    }
    options.update(extra)
    return create_radius_fetch(**options)


async def pay(
    challenge: Any, *, rpc: Rpc | None = None, paid: Callable[[httpx.Request], httpx.Response] = ok, **kw: Any
) -> dict[str, Any]:
    offers: list[Any] = []
    seller = Seller(challenge, paid)
    request_kw = kw.pop("request", {})
    options = {"on_payment_required": lambda o: offers.append(o) or True, **kw}
    res = await buyer(seller, rpc, **options)(RESOURCE_URL, **request_kw)
    retried = seller.requests[1] if len(seller.requests) > 1 else None
    header_name = "payment-signature" if retried is not None and "payment-signature" in retried.headers else "x-payment"
    decoded = from_b64(retried.headers[header_name]) if retried is not None and header_name in retried.headers else None
    return {
        "res": res,
        "seller": seller,
        "retried": retried,
        "header_name": header_name,
        "decoded": decoded,
        "offer": offers[0] if offers else None,
    }


async def rejects(coro: Any, code: str, match: str | None = None) -> RadiusPaymentError:
    with pytest.raises(RadiusPaymentError) as info:
        await coro
    assert info.value.code == code, info.value
    if match:
        import re

        assert re.search(match, str(info.value)), str(info.value)
    return info.value


def lower(v: Any) -> str:
    return str(v).lower()


# -- exact v2 -------------------------------------------------------------------------------------


class TestExactPermit2:
    async def test_sends_payment_signature_with_the_spec_shaped_permit2_authorization(self) -> None:
        r = await pay(v2(EXACT_PERMIT2))
        assert len(r["seller"].requests) == 2
        assert r["header_name"] == "payment-signature"
        assert "x-payment" not in r["retried"].headers
        offer = r["offer"]
        assert (offer.x402_version, offer.scheme, offer.amount, offer.gas_sponsored) == (2, "exact", "13000", False)
        d = r["decoded"]
        assert d["x402Version"] == 2
        assert d["resource"]["url"] == RESOURCE_URL
        assert d["accepted"] == EXACT_PERMIT2  # echoed untouched
        a = d["payload"]["permit2Authorization"]
        assert a["permitted"] == {"token": ASSET, "amount": "13000"}
        assert a["spender"] == X402_EXACT_PERMIT2_PROXY
        assert a["from"] == SIGNER.address
        assert lower(a["witness"]["to"]) == lower(PAY_TO)
        assert "facilitator" not in a["witness"]
        assert all(isinstance(a[k], str) for k in ("nonce", "deadline")) and isinstance(a["witness"]["validAfter"], str)
        assert int(a["deadline"]) - int(time.time()) <= 120
        message = {
            "permitted": {"token": a["permitted"]["token"], "amount": int(a["permitted"]["amount"])},
            "spender": a["spender"],
            "nonce": int(a["nonce"]),
            "deadline": int(a["deadline"]),
            "witness": {"to": a["witness"]["to"], "validAfter": int(a["witness"]["validAfter"])},
        }
        assert (
            recover(
                PERMIT2_DOMAIN, PERMIT2_EXACT_TYPES, "PermitWitnessTransferFrom", message, d["payload"]["signature"]
            )
            == SIGNER.address
        )

    async def test_signs_the_eip2612_permit_when_the_server_sponsors_gas(self) -> None:
        rpc = Rpc(allowance=0, nonce=7)
        r = await pay(v2(EXACT_PERMIT2, {"eip2612GasSponsoring": {"version": "1"}}), rpc=rpc)
        assert r["offer"].gas_sponsored
        info = r["decoded"]["extensions"]["eip2612GasSponsoring"]["info"]
        assert {k: info[k] for k in ("from", "asset", "spender", "amount", "nonce", "version")} == {
            "from": SIGNER.address,
            "asset": ASSET,
            "spender": PERMIT2_ADDRESS,
            "amount": "13000",
            "nonce": "7",
            "version": "1",
        }
        assert info["signature"].startswith("0x")
        assert "eth_sendRawTransaction" not in rpc.calls

    async def test_carries_the_original_method_and_body_on_the_paid_retry(self) -> None:
        r = await pay(
            v2(EXACT_PERMIT2),
            request={"method": "POST", "content": b'{"a":1}', "headers": {"content-type": "application/json"}},
        )
        assert r["retried"].method == "POST"
        assert r["retried"].content == b'{"a":1}'
        assert r["retried"].headers["content-type"] == "application/json"


class TestExactEip3009:
    async def test_sends_the_eip3009_authorization_recoverable_to_the_signer(self) -> None:
        r = await pay(v2(EXACT_EIP3009))
        assert r["header_name"] == "payment-signature"
        d = r["decoded"]
        assert d["accepted"]["extra"] == {"assetTransferMethod": "eip3009", "name": "USDC", "version": "2"}
        auth = d["payload"]["authorization"]
        assert auth["value"] == "13000"
        assert isinstance(auth["validAfter"], str) and isinstance(auth["validBefore"], str)
        assert len(auth["nonce"]) == 66 and auth["nonce"].startswith("0x")
        assert auth["from"] == SIGNER.address
        assert lower(auth["to"]) == lower(PAY_TO)
        assert (
            recover(
                USDC_DOMAIN, EIP3009_TYPES, "TransferWithAuthorization", _auth_message(auth), d["payload"]["signature"]
            )
            == SIGNER.address
        )

    async def test_falls_back_to_the_configured_asset_domain_when_the_challenge_omits_name_and_version(self) -> None:
        r = await pay(v2({**EXACT_EIP3009, "extra": {"assetTransferMethod": "eip3009"}}))
        d = r["decoded"]
        assert d["accepted"]["extra"] == {"assetTransferMethod": "eip3009"}
        auth = d["payload"]["authorization"]
        assert (
            recover(
                USDC_DOMAIN, EIP3009_TYPES, "TransferWithAuthorization", _auth_message(auth), d["payload"]["signature"]
            )
            == SIGNER.address
        )

    async def test_accepts_a_v2_challenge_delivered_in_the_json_body(self) -> None:
        seller = Seller(v2(EXACT_EIP3009), in_body=True)
        res = await buyer(seller)(RESOURCE_URL)
        assert res.status_code == 200
        assert "payment-signature" in seller.requests[1].headers


def _auth_message(auth: dict[str, Any]) -> dict[str, Any]:
    return {
        "from": auth["from"],
        "to": auth["to"],
        "value": int(auth["value"]),
        "validAfter": int(auth["validAfter"]),
        "validBefore": int(auth["validBefore"]),
        "nonce": auth["nonce"],
    }


# -- upto v2 --------------------------------------------------------------------------------------


class TestUpto:
    async def test_sends_a_permit2_witness_bound_to_the_facilitator(self) -> None:
        r = await pay(v2(UPTO))
        offer = r["offer"]
        assert (offer.x402_version, offer.scheme, offer.amount, offer.amount_formatted) == (
            2,
            "upto",
            "500000",
            "0.5 USDC",
        )
        d = r["decoded"]
        assert (d["accepted"]["scheme"], d["accepted"]["amount"]) == ("upto", "500000")
        assert d["accepted"]["extra"] == {"name": "USDC", "version": "2", "facilitatorAddress": FACILITATOR}
        a = d["payload"]["permit2Authorization"]
        assert a["permitted"] == {"token": ASSET, "amount": "500000"}
        assert a["spender"] == X402_UPTO_PERMIT2_PROXY
        assert a["from"] == SIGNER.address
        assert list(a["witness"]) == ["to", "facilitator", "validAfter"]
        assert lower(a["witness"]["facilitator"]) == lower(FACILITATOR)
        message = {
            "permitted": {"token": a["permitted"]["token"], "amount": int(a["permitted"]["amount"])},
            "spender": a["spender"],
            "nonce": int(a["nonce"]),
            "deadline": int(a["deadline"]),
            "witness": {
                "to": a["witness"]["to"],
                "facilitator": a["witness"]["facilitator"],
                "validAfter": int(a["witness"]["validAfter"]),
            },
        }
        assert (
            recover(PERMIT2_DOMAIN, PERMIT2_UPTO_TYPES, "PermitWitnessTransferFrom", message, d["payload"]["signature"])
            == SIGNER.address
        )

    async def test_fails_before_signing_when_the_402_omits_the_facilitator_address(self) -> None:
        seller = Seller(v2({**UPTO, "extra": {"name": "USDC", "version": "2"}}))
        await rejects(buyer(seller)(RESOURCE_URL), "invalid_challenge", "facilitatorAddress")
        assert len(seller.requests) == 1

    async def test_accepts_the_cli_alias_extra_facilitator(self) -> None:
        r = await pay(v2({**UPTO, "extra": {"name": "USDC", "version": "2", "facilitator": FACILITATOR}}))
        assert lower(r["decoded"]["payload"]["permit2Authorization"]["witness"]["facilitator"]) == lower(FACILITATOR)
        assert r["decoded"]["accepted"]["extra"] == {"name": "USDC", "version": "2", "facilitator": FACILITATOR}

    async def test_compares_the_cap_against_the_authorised_maximum(self) -> None:
        seller = Seller(v2(UPTO))
        await rejects(
            buyer(seller, max_per_request={"amount": "499999"})(RESOURCE_URL), "price_above_limit", r"up to 0\.5 USDC"
        )
        assert len(seller.requests) == 1

    async def test_signs_the_eip2612_permit_when_the_server_sponsors_gas(self) -> None:
        r = await pay(v2(UPTO, {"eip2612GasSponsoring": {"version": "1"}}), rpc=Rpc(allowance=0))
        info = r["decoded"]["extensions"]["eip2612GasSponsoring"]["info"]
        assert (info["spender"], info["amount"], info["asset"]) == (PERMIT2_ADDRESS, "500000", ASSET)


class TestUptoReceipts:
    async def settle(self, receipt: dict[str, Any]) -> tuple[httpx.Response, Any]:
        receipts: list[Any] = []
        full = {"success": True, "transaction": "0xabc", "network": NETWORK_ID, "payer": SIGNER.address, **receipt}
        r = await pay(v2(UPTO), paid=receipt_response(full), on_paid=lambda rec, _o: receipts.append(rec))
        return r["res"], receipts[0] if receipts else None

    async def test_reports_the_actually_charged_amount(self) -> None:
        assert (await self.settle({"amount": "60"}))[1].amount == "60"
        assert (await self.settle({"amount": "0"}))[1].amount == "0"
        assert (await self.settle({"amount": "500000"}))[1].amount == "500000"

    async def test_falls_back_to_the_authorised_maximum(self) -> None:
        res, receipt = await self.settle({})
        assert res.status_code == 200
        assert (receipt.success, receipt.amount, receipt.transaction) == (True, "500000", "0xabc")

    async def test_rejects_a_settlement_above_the_signed_maximum(self) -> None:
        await rejects(self.settle({"amount": "500001"}), "invalid_receipt", "exceeds authorized maximum")

    async def test_rejects_malformed_or_negative_amounts(self) -> None:
        for bad in ("-1", "1.5", "nope", 5):
            await rejects(self.settle({"amount": bad}), "invalid_receipt", "non-negative integer")

    async def test_does_not_treat_an_unsuccessful_receipt_as_settled(self) -> None:
        _, receipt = await self.settle({"success": False, "errorReason": "settlement_failed", "transaction": ""})
        assert receipt.success is False and receipt.amount is None

    async def test_leaves_exact_receipts_lenient(self) -> None:
        receipts: list[Any] = []
        full = {"success": True, "transaction": "0xabc", "network": NETWORK_ID, "amount": "nope"}
        r = await pay(v2(EXACT_EIP3009), paid=receipt_response(full), on_paid=lambda rec, _o: receipts.append(rec))
        assert r["res"].status_code == 200
        assert receipts == []


# -- x402 v1 --------------------------------------------------------------------------------------


class TestExactV1:
    async def test_pays_a_v1_challenge_with_x_payment_and_a_v1_envelope(self) -> None:
        r = await pay(V1_EXACT)
        assert r["res"].status_code == 200
        assert r["header_name"] == "x-payment"
        assert "payment-signature" not in r["retried"].headers
        offer = r["offer"]
        assert (offer.x402_version, offer.scheme, offer.amount, offer.amount_formatted, offer.pay_to) == (
            1,
            "exact",
            "13000",
            "0.013 USDC",
            PAY_TO,
        )
        assert (offer.resource.url, offer.resource.description, offer.resource.mime_type) == (
            RESOURCE_URL,
            "access fee",
            "application/json",
        )
        d = r["decoded"]
        assert sorted(d) == ["network", "payload", "scheme", "x402Version"]
        assert (d["x402Version"], d["scheme"], d["network"]) == (1, "exact", NETWORK_ID)
        auth = d["payload"]["authorization"]
        assert (auth["value"], auth["from"], auth["validAfter"]) == ("13000", SIGNER.address, "0")
        now = int(time.time())
        assert now < int(auth["validBefore"]) <= now + 60
        assert (
            recover(
                USDC_DOMAIN, EIP3009_TYPES, "TransferWithAuthorization", _auth_message(auth), d["payload"]["signature"]
            )
            == SIGNER.address
        )

    async def test_rejects_upto_on_v1(self) -> None:
        seller = Seller(
            {
                "x402Version": 1,
                "accepts": [{**{k: v for k, v in UPTO.items() if k != "amount"}, "maxAmountRequired": "500000"}],
            }
        )
        await rejects(buyer(seller)(RESOURCE_URL), "no_compatible_offer", "upto@v1")
        assert len(seller.requests) == 1

    async def test_rejects_a_malformed_v1_price(self) -> None:
        seller = Seller({"x402Version": 1, "accepts": [{**V1_EXACT["accepts"][0], "maxAmountRequired": "-1"}]})  # type: ignore[dict-item]
        await rejects(buyer(seller)(RESOURCE_URL), "invalid_challenge", "maxAmountRequired")


# -- offer selection ------------------------------------------------------------------------------


class TestOfferSelection:
    async def test_rejects_an_unsupported_scheme(self) -> None:
        v1 = Seller(
            {
                "x402Version": 1,
                "accepts": [{**V1_EXACT["accepts"][0], "scheme": "subscription", "maxAmountRequired": "1"}],
            }
        )  # type: ignore[dict-item]
        await rejects(buyer(v1)(RESOURCE_URL), "no_compatible_offer", "subscription@v1")
        await rejects(
            buyer(Seller(v2({**EXACT_EIP3009, "scheme": "subscription"})))(RESOURCE_URL),
            "no_compatible_offer",
            "subscription@v2",
        )

    async def test_rejects_an_unsupported_transfer_method(self) -> None:
        seller = Seller(v2({**EXACT_EIP3009, "extra": {"assetTransferMethod": "erc7710"}}))
        await rejects(buyer(seller)(RESOURCE_URL), "unsupported_transfer_method", "erc7710")

    async def test_rejects_offers_on_another_network_or_asset_before_signing(self) -> None:
        await rejects(buyer(Seller(v2({**UPTO, "network": "eip155:1"})))(RESOURCE_URL), "network_mismatch", "eip155:1")
        v1 = {**V1_EXACT, "accepts": [{**V1_EXACT["accepts"][0], "network": "eip155:723487"}]}  # type: ignore[dict-item]
        await rejects(buyer(Seller(v1))(RESOURCE_URL), "network_mismatch")
        await rejects(buyer(Seller(v2({**EXACT_EIP3009, "asset": PAY_TO})))(RESOURCE_URL), "asset_mismatch")

    async def test_rejects_an_offer_above_max_per_request(self) -> None:
        seller = Seller(v2(EXACT_EIP3009))
        await rejects(
            buyer(seller, max_per_request={"amount": "12999"})(RESOURCE_URL),
            "price_above_limit",
            r"0\.013 USDC exceeds",
        )
        assert len(seller.requests) == 1

    async def test_rejects_unsupported_versions_and_empty_challenges(self) -> None:
        await rejects(buyer(Seller({"x402Version": 3, "accepts": [EXACT_EIP3009]}))(RESOURCE_URL), "invalid_challenge")
        await rejects(buyer(Seller({"x402Version": 1, "accepts": []}))(RESOURCE_URL), "invalid_challenge")

    async def test_takes_the_first_compatible_offer_in_server_order(self) -> None:
        challenge = {
            **v2(EXACT_PERMIT2),
            "accepts": [{**UPTO, "network": "eip155:1"}, {**EXACT_PERMIT2, "amount": "20000"}, EXACT_EIP3009],
        }
        r = await pay(challenge)
        assert (r["offer"].amount, r["offer"].transfer_method) == ("20000", "permit2")
        assert r["decoded"]["accepted"] == {**EXACT_PERMIT2, "amount": "20000"}

    async def test_skips_offers_above_the_cap_rather_than_ranking_by_amount(self) -> None:
        challenge = {**v2(EXACT_PERMIT2), "accepts": [UPTO, {**EXACT_PERMIT2, "amount": "20000"}, EXACT_EIP3009]}
        r = await pay(challenge, max_per_request={"amount": "20000"})
        assert (r["offer"].scheme, r["offer"].amount) == ("exact", "20000")
        await rejects(
            buyer(Seller(challenge), max_per_request={"amount": "12999"})(RESOURCE_URL),
            "price_above_limit",
            r"up to 0\.5 USDC",
        )

    async def test_rejects_an_offer_whose_pay_to_is_not_an_address_before_any_prompt(self) -> None:
        offers: list[Any] = []
        seller = Seller(v2({**EXACT_EIP3009, "payTo": "notanaddress"}))
        await rejects(
            buyer(seller, on_payment_required=lambda o: offers.append(o) or True)(RESOURCE_URL),
            "invalid_challenge",
            "payTo",
        )
        assert offers == [] and len(seller.requests) == 1

    async def test_caps_the_signing_window_at_600_seconds(self) -> None:
        now = int(time.time())
        r = await pay(v2({**EXACT_EIP3009, "maxTimeoutSeconds": 86_400}))
        assert int(r["decoded"]["payload"]["authorization"]["validBefore"]) <= now + 601
        missing = await pay(v2({k: v for k, v in EXACT_EIP3009.items() if k != "maxTimeoutSeconds"}))
        assert int(missing["decoded"]["payload"]["authorization"]["validBefore"]) <= now + 601

    async def test_declined_offers_raise_declined(self) -> None:
        seller = Seller(v2(EXACT_EIP3009))
        err = await rejects(
            buyer(seller, on_payment_required=lambda o: False)(RESOURCE_URL), "declined", r"0\.013 USDC"
        )
        assert err.details.amount == "13000"
        assert len(seller.requests) == 1

    async def test_surfaces_a_402_after_payment_as_payment_rejected(self) -> None:
        def rejected(_r: httpx.Request) -> httpx.Response:
            return httpx.Response(
                402,
                text='{"detail":"nonce already used"}',
                headers={"PAYMENT-REQUIRED": b64({**v2(EXACT_EIP3009), "error": "insufficient_funds"})},
            )

        err = await rejects(buyer(Seller(v2(EXACT_EIP3009), rejected))(RESOURCE_URL), "payment_rejected")
        details = err.details
        assert isinstance(details, PaymentRejectedDetails)
        assert (details.error, details.response.status_code, details.response.text) == (
            "insufficient_funds",
            402,
            '{"detail":"nonce already used"}',
        )
        bare = await rejects(
            buyer(Seller(v2(EXACT_EIP3009), lambda _r: httpx.Response(402, text="nope")))(RESOURCE_URL),
            "payment_rejected",
            "no reason given",
        )
        assert bare.details.response.text == "nope"

    async def test_attaches_the_response_and_body_to_invalid_challenge(self) -> None:
        err = await rejects(
            buyer(lambda _r: httpx.Response(402, text="<html>garbage</html>"))(RESOURCE_URL), "invalid_challenge"
        )
        assert isinstance(err.details, InvalidChallengeDetails)
        assert err.details.response.status_code == 402
        assert "garbage" in (err.details.body or "")

    async def test_sends_a_request_that_already_carries_a_payment_header_straight_through(self) -> None:
        seller = Seller(v2(EXACT_EIP3009))
        res = await buyer(seller)(RESOURCE_URL, headers={"X-PAYMENT": "presigned"})
        assert res.status_code == 200 and len(seller.requests) == 1

    def test_config_errors(self) -> None:
        with pytest.raises(RadiusPaymentError, match="max_per_request is required"):
            create_radius_fetch(signer=PK, max_per_request=None)
        with pytest.raises(RadiusPaymentError, match="network or networks"):
            create_radius_fetch(signer=PK, max_per_request="$1", network="testnet", networks=["testnet"])
        with pytest.raises(RadiusPaymentError, match="listed twice"):
            create_radius_fetch(signer=PK, max_per_request="$1", networks=["testnet", "radius-testnet"])
        with pytest.raises(RadiusPaymentError, match="protocols"):
            create_radius_fetch(signer=PK, max_per_request="$1", protocols=["lightning"])
        with pytest.raises(RadiusPaymentError, match="signer"):
            create_radius_fetch(signer=object(), max_per_request="$1")


# -- redirects ------------------------------------------------------------------------------------


class Hosts:
    """Several origins behind one mock transport; ``seen`` logs every request per host."""

    def __init__(self, routes: dict[str, Callable[[httpx.Request], httpx.Response]]) -> None:
        self.routes = routes
        self.seen: dict[str, list[httpx.Request]] = {h: [] for h in routes}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        self.seen[host].append(request)
        return self.routes[host](request)


def paywall(request: httpx.Request) -> httpx.Response:
    if "payment-signature" in request.headers:
        return httpx.Response(200, text="paid")
    return httpx.Response(402, headers={"PAYMENT-REQUIRED": b64(v2(EXACT_EIP3009))})


def redirector(status: int, location: str) -> Callable[[httpx.Request], httpx.Response]:
    return lambda _r: httpx.Response(status, headers={"location": location})


class TestRedirectsBeforePaying:
    async def test_is_paid_at_the_final_url_never_at_the_redirector(self) -> None:
        hosts = Hosts({"shop.test": paywall, "short.test": redirector(302, "http://shop.test/final")})
        res = await buyer(hosts)("http://short.test/r")
        assert (res.status_code, res.text) == (200, "paid")
        assert [(r.url.path, "payment-signature" in r.headers) for r in hosts.seen["short.test"]] == [("/r", False)]
        assert [(r.url.path, "payment-signature" in r.headers) for r in hosts.seen["shop.test"]] == [
            ("/final", False),
            ("/final", True),
        ]

    async def test_leaves_authorization_and_cookie_behind_on_another_origin(self) -> None:
        hosts = Hosts({"shop.test": paywall, "short.test": redirector(302, "http://shop.test/final")})
        await buyer(hosts)(
            "http://short.test/r", headers={"Authorization": "Bearer s", "Cookie": "a=b", "X-Api-Key": "k"}
        )
        assert hosts.seen["short.test"][0].headers["authorization"] == "Bearer s"
        assert len(hosts.seen["shop.test"]) == 2
        for r in hosts.seen["shop.test"]:
            assert (r.headers.get("authorization"), r.headers.get("cookie"), r.headers.get("x-api-key")) == (
                None,
                None,
                "k",
            )

    async def test_replays_the_original_method_and_body_at_the_final_url(self) -> None:
        hosts = Hosts({"shop.test": paywall, "short.test": redirector(307, "http://shop.test/final")})
        await buyer(hosts)("http://short.test/r", method="POST", content=b'{"a":1}')
        assert [(r.method, r.content, "payment-signature" in r.headers) for r in hosts.seen["shop.test"]] == [
            ("POST", b'{"a":1}', False),
            ("POST", b'{"a":1}', True),
        ]

    async def test_pays_a_post_that_a_302_turned_into_a_get_as_a_post(self) -> None:
        hosts = Hosts({"shop.test": paywall, "short.test": redirector(302, "http://shop.test/final")})
        await buyer(hosts)("http://short.test/r", method="POST", content=b'{"a":1}')
        assert [(r.method, r.content, "payment-signature" in r.headers) for r in hosts.seen["shop.test"]] == [
            ("GET", b"", False),
            ("POST", b'{"a":1}', True),
        ]

    async def test_pays_a_redirected_head_and_get(self) -> None:
        for method in ("HEAD", "GET"):
            hosts = Hosts({"shop.test": paywall, "short.test": redirector(302, "http://shop.test/final")})
            assert (await buyer(hosts)("http://short.test/r", method=method)).status_code == 200
            assert [(r.method, "payment-signature" in r.headers) for r in hosts.seen["shop.test"]] == [
                (method, False),
                (method, True),
            ]


def token_shop(content_origin: str, status: int = 302) -> Callable[[httpx.Request], httpx.Response]:
    receipt = b64({"success": True, "transaction": "0xabc", "network": NETWORK_ID, "payer": SIGNER.address})

    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/content"):
            return httpx.Response(200, text="content") if request.url.query == b"token=abc" else httpx.Response(403)
        if "payment-signature" in request.headers:
            return httpx.Response(
                status, headers={"location": f"{content_origin}/content?token=abc", "PAYMENT-RESPONSE": receipt}
            )
        return httpx.Response(402, headers={"PAYMENT-REQUIRED": b64(v2(EXACT_EIP3009))})

    return handle


class TestRedirectsAfterPaying:
    async def test_follows_a_redirect_after_payment_and_takes_the_receipt_from_it(self) -> None:
        paid: list[Any] = []
        hosts = Hosts({"shop.test": token_shop("http://shop.test")})
        res = await buyer(hosts, on_paid=lambda r, _o: paid.append(r))(
            "http://shop.test/pay", headers={"X-Api-Key": "k"}
        )
        assert (res.status_code, res.text) == (200, "content")
        receipt = get_payment_receipt(res)
        assert receipt and (receipt.success, receipt.transaction) == (True, "0xabc")
        assert len(paid) == 1
        follow_up = hosts.seen["shop.test"][-1]
        assert (
            str(follow_up.url.raw_path, "ascii"),
            follow_up.headers.get("payment-signature"),
            follow_up.headers.get("x-api-key"),
        ) == (
            "/content?token=abc",
            None,
            "k",
        )

    async def test_follows_fetch_rules_303_and_301_302_post_become_get_307_308_repeat(self) -> None:
        cases = [
            (303, "POST", "GET", b""),
            (303, "PUT", "GET", b""),
            (302, "POST", "GET", b""),
            (301, "POST", "GET", b""),
            (302, "PUT", "PUT", b'{"a":1}'),
            (301, "DELETE", "DELETE", b'{"a":1}'),
            (307, "POST", "POST", b'{"a":1}'),
            (308, "PUT", "PUT", b'{"a":1}'),
            (303, "HEAD", "HEAD", b""),
            (302, "HEAD", "HEAD", b""),
        ]
        for status, method, expected, expected_body in cases:
            hosts = Hosts(
                {
                    "shop.test": token_shop("http://cdn.test", status),
                    "cdn.test": lambda _r: httpx.Response(200, text="content"),
                }
            )
            await buyer(hosts)(
                "http://shop.test/pay",
                method=method,
                content=None if method == "HEAD" else b'{"a":1}',
                headers={"content-type": "application/json"},
            )
            hop = hosts.seen["cdn.test"][0]
            assert (status, method, hop.method, hop.content, hop.headers.get("payment-signature")) == (
                status,
                method,
                expected,
                expected_body,
                None,
            )
            assert hop.headers.get("content-type") == (None if expected == "GET" else "application/json")

    async def test_sends_the_follow_up_to_another_origin_without_credentials(self) -> None:
        hosts = Hosts({"shop.test": token_shop("http://cdn.test"), "cdn.test": token_shop("")})
        res = await buyer(hosts)("http://shop.test/pay", headers={"Authorization": "Bearer s", "Cookie": "a=b"})
        assert res.text == "content"
        hop = hosts.seen["cdn.test"][0]
        assert (hop.headers.get("payment-signature"), hop.headers.get("authorization"), hop.headers.get("cookie")) == (
            None,
            None,
            None,
        )


# -- sponsored approvals pass the approval gate (ENG-2389) ----------------------------------------


ERC20_SPONSOR = {"erc20ApprovalGasSponsoring": {"version": "1"}}


class TestApprovalGate:
    async def test_never_refuses_a_sponsored_unlimited_approve(self) -> None:
        seller = Seller(v2(UPTO, ERC20_SPONSOR))
        await rejects(
            buyer(seller, Rpc(allowance=0), permit2_approval="never")(RESOURCE_URL),
            "approval_required",
            "sponsors an approval",
        )
        assert len(seller.requests) == 1

    async def test_on_approval_required_sees_the_sponsored_approval_and_can_decline(self) -> None:
        seen: list[ApprovalRequest] = []
        seller = Seller(v2(UPTO, ERC20_SPONSOR))
        await rejects(
            buyer(seller, Rpc(allowance=0), on_approval_required=lambda r: seen.append(r) or False)(RESOURCE_URL),
            "declined",
        )
        assert len(seen) == 1
        assert (seen[0].reason, seen[0].sponsored, seen[0].amount, seen[0].current_allowance) == (
            "payment",
            "erc20Approval",
            MAX_UINT256,
            0,
        )
        assert len(seller.requests) == 1

    async def test_a_failed_allowance_read_counts_as_no_allowance(self) -> None:
        seller = Seller(v2(UPTO, ERC20_SPONSOR))
        await rejects(
            buyer(seller, Rpc(allowance_error=True), permit2_approval="never")(RESOURCE_URL),
            "approval_required",
            "sponsors an approval",
        )
        assert len(seller.requests) == 1

    async def test_an_eip2612_sponsorship_is_part_of_the_payment_and_not_gated(self) -> None:
        calls: list[Any] = []
        r = await pay(
            v2(UPTO, {"eip2612GasSponsoring": {"version": "1"}}),
            rpc=Rpc(allowance=0),
            permit2_approval="never",
            on_approval_required=lambda req: calls.append(req) or False,
        )
        assert calls == []
        assert r["decoded"]["extensions"]["eip2612GasSponsoring"]["info"]["amount"] == "500000"

    async def test_with_the_permit_available_the_raw_approve_is_never_handed_to_the_scheme(self) -> None:
        r = await pay(v2(UPTO, {"eip2612GasSponsoring": {"version": "1"}, **ERC20_SPONSOR}), rpc=Rpc(allowance=0))
        ext = r["decoded"]["extensions"]
        assert "info" in ext["eip2612GasSponsoring"]
        assert "info" not in ext.get("erc20ApprovalGasSponsoring", {})

    async def test_with_enough_allowance_no_raw_approve_is_handed_to_the_scheme(self) -> None:
        r = await pay(v2(UPTO, ERC20_SPONSOR), rpc=Rpc(allowance=10**12))
        assert "permit2Authorization" in r["decoded"]["payload"]
        assert "info" not in (r["decoded"].get("extensions") or {}).get("erc20ApprovalGasSponsoring", {})

    async def test_an_approved_sponsored_raw_approve_is_signed_for_the_facilitator(self) -> None:
        class TxRpc(Rpc):
            def __call__(self, request: httpx.Request) -> httpx.Response:
                body = json.loads(request.content)
                if body["method"] == "eth_getTransactionCount":
                    return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": "0x5"})
                if body["method"] == "eth_getBlockByNumber":
                    return httpx.Response(
                        200, json={"jsonrpc": "2.0", "id": body["id"], "result": {"baseFeePerGas": "0x1"}}
                    )
                if body["method"] == "eth_maxPriorityFeePerGas":
                    return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": "0x1"})
                return super().__call__(request)

        seen: list[ApprovalRequest] = []
        r = await pay(
            v2(UPTO, ERC20_SPONSOR), rpc=TxRpc(allowance=0), on_approval_required=lambda req: seen.append(req) or True
        )
        assert [s.sponsored for s in seen] == ["erc20Approval"]
        assert r["decoded"]["extensions"]["erc20ApprovalGasSponsoring"]["info"]["signedTransaction"].startswith("0x")
