"""Port of the TypeScript SDK's server tests: the Starlette handler, paid flows, facilitator failures, upstream middleware."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
from starlette.routing import Route

from helpers import PAY_TO, MockFacilitator, asgi_client, b64, from_b64
from radius_sdk import get_payment_receipt, radius_testnet
from radius_sdk.networks import base_sepolia
from radius_sdk.server import RadiusServer, ServerNetwork, create_radius_server, radius_payments, request_of

PAY_TO_2 = "0x1eF420190c299D4d133fE9227F780D7d5cE91BeE"


class FacilitatorHTTP:
    """A facilitator reached over HTTP (httpx mock transport), answering verify/settle with ``respond``."""

    def __init__(self, respond: Callable[[str], httpx.Response] | None = None) -> None:
        self.calls: list[str] = []
        self.bodies: list[Any] = []
        self.respond = respond or self.ok

    @staticmethod
    def ok(path: str) -> httpx.Response:
        if path == "verify":
            return httpx.Response(200, json={"isValid": True, "payer": "0xabc"})
        return httpx.Response(
            200, json={"success": True, "transaction": "0xdeadbeef", "network": "eip155:72344", "payer": "0xabc"}
        )

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.rsplit("/", 1)[-1]
        self.calls.append(path)
        if request.content:
            self.bodies.append(json.loads(request.content))
        return self.respond(path)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))


def make_handler(fac: FacilitatorHTTP | None = None, **opts: Any):
    fac = fac or FacilitatorHTTP()
    options: dict[str, Any] = {
        "network": "testnet",
        "pay_to": PAY_TO_2,
        "facilitator": {"live": False, "http_client": fac.client()},
        "routes": {
            "GET /api/lookup": {"price": "$0.001", "description": "Lookup"},
            "POST /api/query": "0.01",
            "GET /api/atomic": {"price": {"amount": "42"}},
        },
    }
    options.update(opts)
    return radius_payments(**options)


def make_app(pay: Any) -> Starlette:
    async def endpoint(request: Request, payment: Any) -> Response:
        path = request.url.path
        if path == "/health":
            return JSONResponse({"ok": True})
        if path == "/api/lookup":
            return JSONResponse({"data": "secret", "payment": payment.to_dict() if payment else None})
        if path == "/api/fail":
            return JSONResponse({"error": "nope"}, status_code=500)
        if path == "/api/throw":
            raise RuntimeError("boom")
        return JSONResponse({"data": path})

    wrapped = pay.wrap(endpoint)
    return Starlette(routes=[Route("/{path:path}", wrapped, methods=["GET", "POST", "HEAD"])])


async def payload_for(http: httpx.AsyncClient, url: str = "/api/lookup") -> str:
    challenge = await http.get(url)
    pr = from_b64(challenge.headers["payment-required"])
    accepted = dict(pr["accepts"][0])
    accepted["extra"] = {k: v for k, v in accepted["extra"].items() if k != "paymentFlow"}
    return b64(
        {
            "x402Version": 2,
            "resource": pr["resource"],
            "accepted": accepted,
            "payload": {"signature": "0xsig", "permit2Authorization": {}},
        }
    )


async def paid(http: httpx.AsyncClient, url: str = "/api/lookup") -> httpx.Response:
    sig = await payload_for(http, url)
    return await http.get(url, headers={"PAYMENT-SIGNATURE": sig})


class TestChallenge:
    async def test_leaves_unprotected_routes_alone_and_reports_requires_payment_without_io(self) -> None:
        fac = FacilitatorHTTP()
        pay = make_handler(fac)
        async with asgi_client(make_app(pay), "http://seller.test") as http:
            assert (await http.get("/health")).status_code == 200
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/health",
            "raw_path": b"/health",
            "query_string": b"",
            "headers": [],
            "root_path": "",
        }
        assert not pay.requires_payment(Request(scope))
        assert pay.requires_payment(Request({**scope, "path": "/api/lookup", "raw_path": b"/api/lookup"}))
        assert not pay.requires_payment(
            Request({**scope, "path": "/api/lookup", "raw_path": b"/api/lookup", "method": "POST"})
        )
        assert fac.calls == []

    async def test_returns_a_standard_x402_v2_challenge_with_gas_sponsoring_declared(self) -> None:
        async with asgi_client(make_app(make_handler()), "http://seller.test") as http:
            res = await http.get("/api/lookup?q=1")
        assert res.status_code == 402
        assert "application/json" in res.headers["content-type"]
        pr = from_b64(res.headers["payment-required"])
        assert pr["x402Version"] == 2
        assert pr["resource"]["url"] == "http://seller.test/api/lookup?q=1"
        assert pr["resource"]["description"] == "Lookup"
        assert pr["accepts"][0] == {
            "scheme": "exact",
            "network": "eip155:72344",
            "amount": "1000",
            "asset": "0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb",
            "payTo": PAY_TO_2,
            "maxTimeoutSeconds": 300,
            "extra": {
                "assetTransferMethod": "eip3009",
                "name": "Stable Coin",
                "version": "1",
                "paymentFlow": "upfront",
            },
        }
        assert "eip2612GasSponsoring" in pr["extensions"]
        assert "secret" not in res.text
        assert res.headers["cache-control"] == "no-store"

    async def test_supports_shorthand_and_atomic_prices(self) -> None:
        async with asgi_client(make_app(make_handler()), "http://seller.test") as http:
            post = await http.post("/api/query")
            atomic = await http.get("/api/atomic")
        assert from_b64(post.headers["payment-required"])["accepts"][0]["amount"] == "10000"
        assert from_b64(atomic.headers["payment-required"])["accepts"][0]["amount"] == "42"

    async def test_resolves_pay_to_and_price_dynamically_from_the_request(self) -> None:
        async def price(request: Request) -> str:
            await asyncio.sleep(0)
            return "$" + request.query_params["n"]

        pay = radius_payments(
            network="testnet",
            facilitator={"live": False},
            pay_to=lambda request: request.headers["x-pay-to"],
            routes={"GET /p": {"price": price}},
        )
        app = Starlette(routes=[Route("/p", pay.wrap(lambda r: PlainTextResponse("x")))])
        async with asgi_client(app, "http://seller.test") as http:
            res = await http.get("/p?n=2", headers={"x-pay-to": PAY_TO_2})
        accepted = from_b64(res.headers["payment-required"])["accepts"][0]
        assert (accepted["payTo"], accepted["amount"]) == (PAY_TO_2, "2000000")

    async def test_serves_browsers_an_html_paywall_page(self) -> None:
        async with asgi_client(make_app(make_handler()), "http://seller.test") as http:
            res = await http.get("/api/lookup", headers={"accept": "text/html", "user-agent": "Mozilla/5.0"})
        assert res.status_code == 402
        assert "text/html" in res.headers["content-type"]


class TestPaidFlow:
    async def test_settles_before_the_handler_passes_the_receipt_and_attaches_payment_response(self) -> None:
        fac = FacilitatorHTTP()
        settled: list[tuple[Any, str]] = []
        pay = make_handler(fac, on_settled=lambda receipt, request: settled.append((receipt, str(request.url))))
        async with asgi_client(make_app(pay), "http://seller.test") as http:
            res = await paid(http)
        assert res.status_code == 200
        body = res.json()
        assert body["data"] == "secret"
        assert body["payment"] == {
            "success": True,
            "protocol": "x402",
            "transaction": "0xdeadbeef",
            "network": "eip155:72344",
            "payer": "0xabc",
            "amount": "1000",
            "explorerUrl": "https://testnet.radiustech.xyz/tx/0xdeadbeef",
        }
        assert fac.calls == ["settle"]  # the upfront flow settles without a separate verify
        receipt = get_payment_receipt(res)
        assert receipt and (receipt.success, receipt.transaction, receipt.network) == (
            True,
            "0xdeadbeef",
            "eip155:72344",
        )
        assert "private" in res.headers["cache-control"]
        assert [(r.transaction, url) for r, url in settled] == [("0xdeadbeef", "http://seller.test/api/lookup")]
        sent = fac.bodies[0]
        assert sent["x402Version"] == 2 and sent["paymentRequirements"]["amount"] == "1000"

    async def test_settle_after_runs_the_handler_first_and_the_handler_sees_no_receipt(self) -> None:
        fac = FacilitatorHTTP(
            lambda p: (
                FacilitatorHTTP.ok(p)
                if p == "verify"
                else httpx.Response(200, json={"success": True, "transaction": "0xafter", "network": "eip155:72344"})
            )
        )
        seen: list[Any] = []

        async def handler(request: Request, payment: Any) -> Response:
            seen.append(payment)
            return JSONResponse({"ok": True})

        pay = make_handler(fac, settle="after")
        app = Starlette(routes=[Route("/api/lookup", pay.wrap(handler))])
        async with asgi_client(app, "http://seller.test") as http:
            res = await paid(http)
        assert res.status_code == 200
        assert seen == [None]
        assert fac.calls == ["verify", "settle"]
        assert get_payment_receipt(res).transaction == "0xafter"  # type: ignore[union-attr]
        challenge_extra = fac.bodies[0]["paymentRequirements"]["extra"]
        assert "paymentFlow" not in challenge_extra

    async def test_withholds_the_resource_when_settlement_fails_and_skips_on_settled(self) -> None:
        fac = FacilitatorHTTP(
            lambda p: httpx.Response(
                200,
                json={
                    "success": False,
                    "errorReason": "insufficient_funds",
                    "transaction": "",
                    "network": "eip155:72344",
                },
            )
        )
        settled: list[Any] = []
        async with asgi_client(
            make_app(make_handler(fac, on_settled=lambda r, req: settled.append(r))), "http://seller.test"
        ) as http:
            res = await paid(http)
        assert res.status_code == 402
        assert "secret" not in res.text
        assert settled == []

    async def test_rejects_a_malformed_payment_header_without_calling_the_facilitator(self) -> None:
        fac = FacilitatorHTTP()
        async with asgi_client(make_app(make_handler(fac)), "http://seller.test") as http:
            res = await http.get("/api/lookup", headers={"PAYMENT-SIGNATURE": "not-base64-json"})
        assert res.status_code == 402
        assert fac.calls == []

    async def test_streams_the_handler_response_through_in_settle_before_mode(self) -> None:
        gate = asyncio.Event()

        async def handler(request: Request) -> Response:
            async def stream():
                yield b"first,"
                await gate.wait()
                yield b"second"

            return StreamingResponse(stream(), media_type="text/event-stream")

        pay = make_handler()
        app = Starlette(routes=[Route("/api/lookup", pay.wrap(handler))])
        async with asgi_client(app, "http://seller.test") as http:
            sig = await payload_for(http)
            # httpx's ASGI transport buffers, so drive the endpoint directly and read the stream.
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/api/lookup",
            "raw_path": b"/api/lookup",
            "query_string": b"",
            "root_path": "",
            "scheme": "http",
            "server": ("seller.test", 80),
            "headers": [(b"host", b"seller.test"), (b"payment-signature", sig.encode())],
        }
        response = await pay(Request(scope), handler)
        assert response.status_code == 200
        assert get_payment_receipt(response).transaction == "0xdeadbeef"  # type: ignore[union-attr]
        it = response.body_iterator.__aiter__()  # type: ignore[attr-defined]
        assert await it.__anext__() == b"first,"
        gate.set()
        assert await it.__anext__() == b"second"
        with pytest.raises(StopAsyncIteration):
            await it.__anext__()

    async def test_returns_the_handler_error_with_the_settlement_receipt_when_a_paid_handler_fails(self) -> None:
        fac = FacilitatorHTTP(
            lambda p: httpx.Response(200, json={"success": True, "transaction": "0x2", "network": "eip155:72344"})
        )
        pay = make_handler(fac, routes={"GET /api/fail": "$0.001", "GET /api/throw": "$0.001"})
        async with asgi_client(make_app(pay), "http://seller.test") as http:
            failed = await paid(http, "/api/fail")
            threw = await paid(http, "/api/throw")
        assert failed.status_code == 500
        assert get_payment_receipt(failed).transaction == "0x2"  # type: ignore[union-attr]
        assert threw.status_code == 500
        assert threw.json() == {"error": "payment_processing_error", "message": "boom"}
        assert get_payment_receipt(threw).transaction == "0x2"  # type: ignore[union-attr]

    async def test_a_handler_taking_only_the_request_works(self) -> None:
        pay = make_handler()
        app = Starlette(routes=[Route("/api/lookup", pay.wrap(lambda request: PlainTextResponse("plain")))])
        async with asgi_client(app, "http://seller.test") as http:
            res = await paid(http)
        assert (res.status_code, res.text) == (200, "plain")


class TestFacilitatorWithoutAnAnswer:
    @staticmethod
    def gateway_timeout(_path: str) -> httpx.Response:
        return httpx.Response(504, text="<html>504 Gateway Time-out</html>", headers={"content-type": "text/html"})

    async def run(self, respond: Callable[[str], httpx.Response], **opts: Any) -> httpx.Response:
        async with asgi_client(make_app(make_handler(FacilitatorHTTP(respond), **opts)), "http://seller.test") as http:
            return await paid(http)

    async def test_answers_502_when_settle_returns_an_error_page(self) -> None:
        res = await self.run(self.gateway_timeout)
        assert res.status_code == 502
        assert res.json()["error"] == "facilitator_error"

    async def test_answers_502_when_the_settle_connection_fails(self) -> None:
        def fail(_path: str) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        res = await self.run(fail)
        assert res.status_code == 502
        assert "secret" not in res.text

    async def test_answers_502_when_settle_fails_after_the_handler(self) -> None:
        res = await self.run(
            lambda p: FacilitatorHTTP.ok(p) if p == "verify" else self.gateway_timeout(p), settle="after"
        )
        assert res.status_code == 502
        assert "secret" not in res.text

    async def test_answers_502_when_verify_returns_an_error_page(self) -> None:
        res = await self.run(self.gateway_timeout, settle="after")
        assert res.status_code == 502

    async def test_keeps_402_for_the_facilitators_own_settle_rejection(self) -> None:
        res = await self.run(
            lambda p: httpx.Response(
                400,
                json={
                    "success": False,
                    "errorReason": "insufficient_funds",
                    "transaction": "",
                    "network": "eip155:72344",
                },
            )
        )
        assert res.status_code == 402

    async def test_answers_502_while_supported_is_unreachable_then_recovers(self) -> None:
        calls = {"n": 0}

        def supported(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(503, text="down")
            return httpx.Response(
                200,
                json={
                    "kinds": [
                        {
                            "x402Version": 2,
                            "scheme": "exact",
                            "network": "eip155:72344",
                            "extra": {"assetTransferMethod": "eip3009", "name": "Stable Coin", "version": "1"},
                        }
                    ],
                    "extensions": [],
                    "signers": {},
                },
            )

        from radius_sdk.server import RadiusFacilitatorClient

        fac = RadiusFacilitatorClient(
            radius_testnet,
            {"url": "https://fac.test"},
            sync_http_client=httpx.Client(transport=httpx.MockTransport(supported)),
        )
        pay = radius_payments(network="testnet", pay_to=PAY_TO_2, facilitator=fac, routes={"GET /api/lookup": "$0.001"})
        async with asgi_client(make_app(pay), "http://seller.test") as http:
            first = await http.get("/api/lookup")
            second = await http.get("/api/lookup")
        assert first.status_code == 502
        assert "radius-testnet" in first.json()["message"]
        assert second.status_code == 402
        # The live facilitator does not list eip2612GasSponsoring, so the declaration is withdrawn.
        assert "extensions" not in from_b64(second.headers["payment-required"])


class TestNetworks:
    async def test_offers_one_option_per_network_in_order_each_settled_by_its_own_facilitator(self) -> None:
        radius_fac, base_fac = MockFacilitator(radius_testnet), MockFacilitator(base_sepolia)
        pay = radius_payments(
            networks=[ServerNetwork("testnet", radius_fac), ServerNetwork("base-sepolia", base_fac)],
            pay_to=PAY_TO,
            routes={"GET /api/lookup": "$0.001"},
        )
        async with asgi_client(make_app(pay), "http://seller.test") as http:
            res = await http.get("/api/lookup")
        accepts = from_b64(res.headers["payment-required"])["accepts"]
        assert [(a["network"], a["asset"], a["amount"]) for a in accepts] == [
            ("eip155:72344", radius_testnet.asset.address, "1000"),
            ("eip155:84532", base_sepolia.asset.address, "1000"),
        ]
        assert accepts[1]["extra"]["name"] == "USDC"

    def test_rejects_an_asset_named_price_with_several_networks_and_duplicate_networks(self) -> None:
        radius = RadiusServer(networks=["testnet", ServerNetwork("base-sepolia", {"live": True})])
        with pytest.raises(ValueError, match="cannot apply to several networks"):
            radius.routes(pay_to=PAY_TO, routes={"GET /x": {"price": {"amount": "1", "asset": PAY_TO}}})
        with pytest.raises(ValueError, match="listed twice"):
            RadiusServer(networks=["testnet", "radius-testnet"])
        with pytest.raises(ValueError, match="network or networks"):
            RadiusServer(network="testnet", networks=["testnet"])
        with pytest.raises(ValueError, match="no default facilitator"):
            RadiusServer(network="base")


class TestUpstreamMiddleware:
    async def test_routes_and_server_plug_into_the_x402_fastapi_middleware(self) -> None:
        from fastapi import FastAPI
        from x402.http.middleware.fastapi import payment_middleware

        fac = MockFacilitator(radius_testnet)
        seen: list[str] = []
        radius = create_radius_server(
            network="testnet",
            facilitator=fac,
            on_settled=lambda r, ctx: seen.append(f"{r.transaction}:{'request' if request_of(ctx) else 'upstream'}"),
        )
        app = FastAPI()
        middleware = payment_middleware(
            radius.routes(pay_to=PAY_TO_2, routes={"GET /api/lookup": "$0.001"}), radius.server
        )

        @app.middleware("http")
        async def x402(request: Request, call_next: Any) -> Response:
            return await middleware(request, call_next)

        @app.get("/api/lookup")
        async def lookup() -> dict[str, str]:
            return {"data": "secret"}

        async with asgi_client(app, "http://seller.test") as http:
            challenge = await http.get("/api/lookup")
            assert challenge.status_code == 402
            pr = from_b64(challenge.headers["payment-required"])
            assert pr["accepts"][0]["extra"] == {
                "assetTransferMethod": "eip3009",
                "name": "Stable Coin",
                "version": "1",
                "paymentFlow": "upfront",
            }
            accepted = {
                **pr["accepts"][0],
                "extra": {k: v for k, v in pr["accepts"][0]["extra"].items() if k != "paymentFlow"},
            }
            sig = b64(
                {
                    "x402Version": 2,
                    "resource": pr["resource"],
                    "accepted": accepted,
                    "payload": {"signature": "0xsig", "permit2Authorization": {"from": "0xabc"}},
                }
            )
            res = await http.get("/api/lookup", headers={"PAYMENT-SIGNATURE": sig})
        assert res.status_code == 200
        assert res.json() == {"data": "secret"}
        assert get_payment_receipt(res).transaction == "0x" + "ab" * 32  # type: ignore[union-attr]
        assert seen == ["0x" + "ab" * 32 + ":upstream"]
