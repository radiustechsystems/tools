"""MPP: wire format (challenges, credentials, receipts), the seller's credential checks, and the buyer's choices."""

from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from helpers import PAY_TO, PK, SIGNER, MockFacilitator, asgi_client, from_b64, recover_eip3009
from radius_sdk import get_payment_receipt, radius_testnet
from radius_sdk.client import create_radius_fetch
from radius_sdk.errors import RadiusPaymentError
from radius_sdk.mpp import (
    MppChallenge,
    MppReceipt,
    base64url_decode,
    canonical_json,
    encode_request,
    js_json,
    mpp_challenge_id,
    mpp_challenge_nonce,
    parse_mpp_challenges,
    parse_mpp_credential,
    parse_mpp_receipt,
    serialize_mpp_challenge,
    serialize_mpp_credential,
    serialize_mpp_receipt,
)
from radius_sdk.networks import base_sepolia
from radius_sdk.server import ServerNetwork, radius_payments

SECRET = "s" * 32


def challenge(**kw: Any) -> MppChallenge:
    request = kw.pop(
        "request",
        {
            "amount": "1000",
            "currency": radius_testnet.asset.address,
            "recipient": PAY_TO,
            "methodDetails": {"chainId": 72344},
        },
    )
    c = MppChallenge(
        id="",
        realm="shop.test",
        method="evm",
        intent="charge",
        request=request,
        request_encoded=encode_request(request),
        **kw,
    )
    c.id = mpp_challenge_id(SECRET, c)
    return c


class TestWire:
    def test_canonical_json_sorts_keys_and_prints_numbers_like_javascript(self) -> None:
        assert (
            canonical_json({"b": 1, "a": [True, None, {"d": "x", "c": 2.5}]})
            == '{"a":[true,null,{"c":2.5,"d":"x"}],"b":1}'
        )
        cases = {
            1.0: "1",
            0.1: "0.1",
            1e21: "1e+21",
            1e-7: "1e-7",
            123456789012345680000.0: "123456789012345680000",
            1.5e-6: "0.0000015",
            -0.5: "-0.5",
            2.5e25: "2.5e+25",
        }
        for value, expected in cases.items():
            assert js_json(value) == expected, value
        assert js_json("é\n") == '"é\\n"'

    def test_challenges_round_trip_through_www_authenticate(self) -> None:
        c = challenge(description='Look "up" — ✓ 𝄞', expires="2030-01-01T00:00:00.000Z", opaque="b3BhcXVl")
        header = serialize_mpp_challenge(c)
        assert "\\u2014" in header and "\\ud834\\udd1e" in header  # escaped as JavaScript does
        other = 'Bearer realm="x", ' + header + ', Payment id="bad"'
        [parsed] = parse_mpp_challenges(other)
        assert (parsed.id, parsed.realm, parsed.description, parsed.expires, parsed.opaque) == (
            c.id,
            c.realm,
            c.description,
            c.expires,
            c.opaque,
        )
        assert parsed.request == c.request and parsed.request_encoded == c.request_encoded
        assert mpp_challenge_id(SECRET, parsed) == c.id

    def test_skips_malformed_challenges_and_rejects_duplicates(self) -> None:
        assert parse_mpp_challenges(None) == []
        assert (
            parse_mpp_challenges('Payment id="a", id="b", realm="r", method="evm", intent="charge", request="e30"')
            == []
        )
        assert parse_mpp_challenges('Payment id="a", realm="r", method="evm", intent="charge", request="!!"') == []
        assert len(parse_mpp_challenges('Payment id="a", realm="r", method="evm", intent="charge", request="e30"')) == 1

    def test_the_challenge_id_binds_every_parameter(self) -> None:
        base = challenge(expires="2030-01-01T00:00:00.000Z")
        assert mpp_challenge_id(SECRET, base) != mpp_challenge_id("t" * 32, base)
        for change in (
            {"realm": "other"},
            {"expires": "2031-01-01T00:00:00.000Z"},
            {"digest": "d"},
            {"opaque": "o"},
            {"header": "X-Pay"},
        ):
            changed = MppChallenge(**{**base.__dict__, **change})
            assert mpp_challenge_id(SECRET, changed) != base.id, change
        # `Authorization` is the default credential header, so naming it changes nothing.
        assert mpp_challenge_id(SECRET, MppChallenge(**{**base.__dict__, "header": "Authorization"})) == base.id

    def test_credentials_and_receipts_round_trip(self) -> None:
        c = challenge(expires="2030-01-01T00:00:00.000Z")
        payload = {
            "type": "authorization",
            "from": SIGNER.address,
            "to": PAY_TO,
            "value": "1000",
            "validAfter": "0",
            "validBefore": "1",
            "nonce": mpp_challenge_nonce(c),
            "signature": "0x00",
        }
        header = serialize_mpp_credential(c, payload, "did:pkh:eip155:72344:" + SIGNER.address)
        wire = json.loads(base64url_decode(header.split(" ", 1)[1]))
        assert list(wire) == ["challenge", "payload", "source"]
        assert list(wire["challenge"]) == ["id", "realm", "method", "intent", "expires", "request"]
        parsed = parse_mpp_credential(header)
        assert (
            parsed is not None
            and parsed.challenge.id == c.id
            and parsed.payload == payload
            and parsed.source.endswith(SIGNER.address)
        )  # type: ignore[union-attr]
        assert parse_mpp_credential("Bearer x") is None
        with pytest.raises(ValueError):
            parse_mpp_credential("Payment " + base64.urlsafe_b64encode(b'{"payload":{}}').decode())
        r = parse_mpp_receipt(serialize_mpp_receipt(MppReceipt("evm", "0xabc", "success", "2030-01-01T00:00:00.000Z")))
        assert (r.method, r.reference, r.status) == ("evm", "0xabc", "success")
        with pytest.raises(ValueError):
            parse_mpp_receipt(base64.urlsafe_b64encode(b'{"method":"evm"}').decode())

    def test_the_nonce_is_keccak_of_the_json_id_realm_pair(self) -> None:
        from eth_utils import keccak

        assert (
            mpp_challenge_nonce({"id": "abc", "realm": "shop.test"}) == "0x" + keccak(text='["abc","shop.test"]').hex()
        )


def seller(
    *, settle: str = "before", networks: Any = None, fac: MockFacilitator | None = None, price: Any = "$0.001"
) -> tuple[Any, MockFacilitator, list[Any]]:
    fac = fac or MockFacilitator(radius_testnet)
    seen: list[Any] = []

    async def handler(request: Request, payment: Any) -> JSONResponse:
        seen.append(payment)
        return JSONResponse({"ok": True})

    options: dict[str, Any] = {
        "pay_to": PAY_TO,
        "routes": {"GET /api/lookup": {"price": price, "description": "One lookup"}},
        "settle": settle,
        "mpp": {"secret_key": SECRET},
    }
    if networks is None:
        options.update(network="testnet", facilitator=fac)
    else:
        options.update(networks=networks)
    pay = radius_payments(**options)
    return Starlette(routes=[Route("/api/lookup", pay.wrap(handler))]), fac, seen


def mpp_buyer(app: Any, **kw: Any) -> Any:
    return create_radius_fetch(
        network="testnet", signer=PK, max_per_request="$0.01", protocols=["mpp"], http_client=asgi_client(app), **kw
    )


class TestSeller:
    async def test_every_402_also_offers_an_mpp_challenge_mirroring_the_x402_offer(self) -> None:
        app, _, _ = seller()
        async with asgi_client(app) as http:
            res = await http.get("/api/lookup")
        [c] = parse_mpp_challenges(res.headers["www-authenticate"])
        accept = from_b64(res.headers["payment-required"])["accepts"][0]
        assert (c.method, c.intent, c.realm, c.description) == ("evm", "charge", "shop.test", "One lookup")
        assert c.request == {
            "amount": accept["amount"],
            "currency": accept["asset"],
            "recipient": accept["payTo"],
            "methodDetails": {"chainId": 72344, "credentialTypes": ["authorization"], "decimals": 6},
        }
        expires = datetime.fromisoformat(c.expires.replace("Z", "+00:00"))  # type: ignore[union-attr]
        assert timedelta(seconds=290) < expires - datetime.now(timezone.utc) <= timedelta(seconds=300)

    async def test_mirrors_only_eip3009_offers(self) -> None:
        app, _, _ = seller(fac=MockFacilitator(radius_testnet, methods=("permit2",)))
        async with asgi_client(app) as http:
            res = await http.get("/api/lookup")
        assert "www-authenticate" not in res.headers

    @pytest.mark.parametrize("settle", ["before", "after"])
    async def test_settles_a_credential_and_answers_with_payment_receipt(self, settle: str) -> None:
        app, fac, seen = seller(settle=settle)
        res = await mpp_buyer(app)("http://shop.test/api/lookup")
        assert res.status_code == 200
        receipt = get_payment_receipt(res, radius_testnet)
        assert receipt and (receipt.protocol, receipt.transaction) == ("mpp", "0x" + "ab" * 32)
        assert "private" in res.headers["cache-control"]
        assert len(fac.settled) == 1
        payload, requirements = fac.settled[0]
        assert payload.accepted.extra["assetTransferMethod"] == "eip3009"
        auth = payload.payload["authorization"]
        assert recover_eip3009(72344, requirements.asset, "Stable Coin", "1", payload.payload) == SIGNER.address
        assert auth["value"] == "1000"
        if settle == "before":
            assert seen[0].protocol == "mpp" and seen[0].amount == "1000"
        else:
            assert seen == [None]

    async def test_rejects_tampered_credentials_with_a_problem_and_fresh_challenges(self) -> None:
        app, fac, _ = seller()
        async with asgi_client(app) as http:
            first = await http.get("/api/lookup")
            [c] = parse_mpp_challenges(first.headers["www-authenticate"])
            buyer = mpp_buyer(app)
            from radius_sdk.client import MppOffer, Resource

            offer = MppOffer(
                amount="1000",
                amount_formatted="",
                asset=c.request["currency"],
                pay_to=PAY_TO,
                network=radius_testnet,
                resource=Resource(""),
                challenge=c,
            )
            good = buyer._mpp_credential(offer)[1]

            async def send(authorization: str) -> httpx.Response:
                return await http.get("/api/lookup", headers={"Authorization": authorization})

            def mutate(fn: Any) -> str:
                wire = json.loads(base64url_decode(good.split(" ", 1)[1]))
                fn(wire)
                return "Payment " + base64.urlsafe_b64encode(json.dumps(wire).encode()).decode().rstrip("=")

            cases = {
                "challenge was not issued by this server": mutate(lambda w: w["challenge"].update(id="forged")),
                "authorization amount mismatch": mutate(lambda w: w["payload"].update(value="1")),
                "authorization recipient mismatch": mutate(lambda w: w["payload"].update(to=SIGNER.address)),
                "authorization is not bound to this challenge": mutate(
                    lambda w: w["payload"].update(nonce="0x" + "00" * 32)
                ),
                "credential source does not match the payer": mutate(
                    lambda w: w.update(source="did:pkh:eip155:72344:" + PAY_TO)
                ),
                "malformed credential": "Payment !!!",
            }
            for reason, authorization in cases.items():
                res = await send(authorization)
                assert res.status_code == 402, reason
                assert res.headers["content-type"] == "application/problem+json"
                assert reason in res.json()["detail"], (reason, res.json())
                assert parse_mpp_challenges(res.headers["www-authenticate"]), reason
                assert "payment-required" in res.headers
            # The realm is bound by the HMAC too, so a rewritten one fails the id check first.
            forged_realm = await send(mutate(lambda w: w["challenge"].update(realm="evil.test")))
            assert "not issued by this server" in forged_realm.json()["detail"]
            assert fac.settled == []
            assert (await send(good)).status_code == 200

    async def test_a_challenge_issued_for_another_host_is_refused(self) -> None:
        app, fac, _ = seller()
        async with asgi_client(app, "http://other.test") as http:
            [c] = parse_mpp_challenges((await http.get("/api/lookup")).headers["www-authenticate"])
        assert c.realm == "other.test"
        from radius_sdk.client import MppOffer, Resource

        credential = mpp_buyer(app)._mpp_credential(
            MppOffer("1000", "", c.request["currency"], PAY_TO, radius_testnet, Resource(""), c)
        )[1]
        async with asgi_client(app) as http:
            res = await http.get("/api/lookup", headers={"Authorization": credential})
        assert res.json()["detail"] == "challenge realm does not match"
        assert fac.settled == []

    async def test_a_price_change_invalidates_outstanding_challenges(self) -> None:
        prices = iter(["$0.001", "$0.002"])
        state = {"price": next(prices)}
        app, _, _ = seller(price=lambda request: state["price"])
        async with asgi_client(app) as http:
            [c] = parse_mpp_challenges((await http.get("/api/lookup")).headers["www-authenticate"])
            buyer = mpp_buyer(app)
            from radius_sdk.client import MppOffer, Resource

            credential = buyer._mpp_credential(
                MppOffer("1000", "", c.request["currency"], PAY_TO, radius_testnet, Resource(""), c)
            )[1]
            state["price"] = next(prices)
            res = await http.get("/api/lookup", headers={"Authorization": credential})
        assert res.status_code == 402
        assert "does not match this route's price" in res.json()["detail"]

    async def test_answers_502_when_the_facilitator_gives_no_answer(self) -> None:
        fac = MockFacilitator(radius_testnet)
        fac.settle_error = ConnectionError("down")
        app, _, _ = seller(fac=fac)
        res = await mpp_buyer(app)("http://shop.test/api/lookup")
        assert res.status_code == 502
        assert res.json()["error"] == "facilitator_error"

    async def test_offers_one_challenge_per_network(self) -> None:
        app, _, _ = seller(
            networks=[
                ServerNetwork("testnet", MockFacilitator(radius_testnet)),
                ServerNetwork("base-sepolia", MockFacilitator(base_sepolia)),
            ]
        )
        async with asgi_client(app) as http:
            res = await http.get("/api/lookup")
        assert [
            c.request["methodDetails"]["chainId"] for c in parse_mpp_challenges(res.headers["www-authenticate"])
        ] == [72344, 84532]


class TestBuyer:
    async def test_prefers_x402_by_default_and_mpp_when_asked(self) -> None:
        app, fac, _ = seller()
        x402 = await create_radius_fetch(
            network="testnet", signer=PK, max_per_request="$0.01", http_client=asgi_client(app)
        )("http://shop.test/api/lookup")
        assert get_payment_receipt(x402).protocol == "x402"  # type: ignore[union-attr]
        mpp = await create_radius_fetch(
            network="testnet",
            signer=PK,
            max_per_request="$0.01",
            protocols=["mpp", "x402"],
            http_client=asgi_client(app),
        )("http://shop.test/api/lookup")
        assert get_payment_receipt(mpp, radius_testnet).protocol == "mpp"  # type: ignore[union-attr]

    async def test_never_overwrites_the_requests_own_authorization(self) -> None:
        app, _, _ = seller()
        with pytest.raises(RadiusPaymentError) as info:
            await mpp_buyer(app)("http://shop.test/api/lookup", headers={"Authorization": "Bearer mine"})
        assert info.value.code == "no_compatible_offer"
        assert "already sets Authorization" in str(info.value)

    async def test_skips_a_challenge_naming_another_credential_header(self) -> None:
        def handler(_r: httpx.Request) -> httpx.Response:
            c = challenge(header="Cookie", expires="2030-01-01T00:00:00.000Z")
            return httpx.Response(402, headers={"WWW-Authenticate": serialize_mpp_challenge(c)})

        buyer = create_radius_fetch(
            network="testnet",
            signer=PK,
            max_per_request="$0.01",
            protocols=["mpp"],
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(RadiusPaymentError) as info:
            await buyer("http://shop.test/x")
        assert info.value.code == "no_compatible_offer"

    async def test_refuses_an_expired_challenge_and_an_offer_above_the_cap(self) -> None:
        expired = challenge(
            expires="2020-01-01T00:00:00.000Z",
            request={
                "amount": "1000",
                "currency": radius_testnet.asset.address,
                "recipient": PAY_TO,
                "methodDetails": {"chainId": 72344, "credentialTypes": ["authorization"]},
            },
        )
        pricey = challenge(
            expires="2030-01-01T00:00:00.000Z",
            request={
                "amount": "99000000",
                "currency": radius_testnet.asset.address,
                "recipient": PAY_TO,
                "methodDetails": {"chainId": 72344, "credentialTypes": ["authorization"]},
            },
        )
        for c, code in ((expired, "invalid_challenge"), (pricey, "price_above_limit")):
            transport = httpx.MockTransport(
                lambda _r, c=c: httpx.Response(402, headers={"WWW-Authenticate": serialize_mpp_challenge(c)})
            )
            buyer = create_radius_fetch(
                network="testnet",
                signer=PK,
                max_per_request="$0.01",
                protocols=["mpp"],
                http_client=httpx.AsyncClient(transport=transport),
            )
            with pytest.raises(RadiusPaymentError) as info:
                await buyer("http://shop.test/x")
            assert info.value.code == code
