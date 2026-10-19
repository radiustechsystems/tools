"""The ASGI middleware (the counterpart of the TypeScript SDK's Hono middleware) and ``proxy_to``."""

from __future__ import annotations

import gzip
from typing import Any

import httpx
from fastapi import FastAPI
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response
from starlette.routing import Route

from helpers import PAY_TO, PK, MockFacilitator, asgi_client
from radius_sdk import get_payment_receipt, radius_testnet
from radius_sdk.client import create_radius_fetch
from radius_sdk.server import proxy_to, radius_payments
from radius_sdk.starlette import RadiusPaymentsMiddleware


def fastapi_app(**opts: Any) -> tuple[FastAPI, MockFacilitator, list[Any]]:
    fac = MockFacilitator(radius_testnet)
    settled: list[Any] = []
    app = FastAPI()
    app.add_middleware(
        RadiusPaymentsMiddleware,
        network="testnet",
        pay_to=lambda request: request.headers.get("x-pay-to", PAY_TO),
        facilitator=fac,
        routes={"GET /api/*": {"price": "$0.001", "description": "Lookup"}},
        on_settled=lambda receipt, request: settled.append((receipt.transaction, request.url.path)),
        **opts,
    )

    @app.get("/health")
    async def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/api/lookup")
    async def lookup(request: Request) -> dict[str, Any]:
        payment = getattr(request.state, "radius_payment", None)
        return {"data": "secret", "paidBy": payment.payer if payment else None}

    @app.get("/api/fail")
    async def fail() -> Response:
        return JSONResponse({"error": "nope"}, status_code=500)

    return app, fac, settled


def buyer(app: Any) -> Any:
    return create_radius_fetch(network="testnet", signer=PK, max_per_request="$0.01", http_client=asgi_client(app))


class TestMiddleware:
    async def test_free_routes_pass_through_and_paid_routes_answer_402(self) -> None:
        app, fac, _ = fastapi_app()
        async with asgi_client(app) as http:
            assert (await http.get("/health")).json() == {"ok": True}
            assert (await http.get("/api/lookup")).status_code == 402
        assert fac.settled == []

    async def test_paid_handlers_read_the_receipt_from_request_state(self) -> None:
        app, fac, settled = fastapi_app()
        res = await buyer(app)("http://shop.test/api/lookup")
        assert res.status_code == 200
        assert res.json() == {"data": "secret", "paidBy": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"}
        assert get_payment_receipt(res).transaction == "0x" + "ab" * 32  # type: ignore[union-attr]
        assert settled == [("0x" + "ab" * 32, "/api/lookup")]
        assert len(fac.settled) == 1

    async def test_settle_after_buffers_and_settles_on_success_only(self) -> None:
        app, fac, _ = fastapi_app(settle="after")
        ok = await buyer(app)("http://shop.test/api/lookup")
        assert ok.status_code == 200 and ok.json()["paidBy"] is None
        failed = await buyer(app)("http://shop.test/api/fail")
        assert failed.status_code == 500
        assert len(fac.verified) == 2 and len(fac.settled) == 1

    async def test_dynamic_pay_to_reads_the_request(self) -> None:
        app, _, _ = fastapi_app()
        async with asgi_client(app) as http:
            res = await http.get("/api/lookup", headers={"x-pay-to": "0x1eF420190c299D4d133fE9227F780D7d5cE91BeE"})
        from helpers import from_b64

        assert (
            from_b64(res.headers["payment-required"])["accepts"][0]["payTo"]
            == "0x1eF420190c299D4d133fE9227F780D7d5cE91BeE"
        )


class TestProxyTo:
    async def test_forwards_method_path_query_and_body_without_payment_credentials(self) -> None:
        seen: list[httpx.Request] = []

        def origin(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            if request.url.path == "/base/redirect":
                return httpx.Response(302, headers={"location": "/elsewhere"})
            body = gzip.compress(b"origin says hi")
            return httpx.Response(
                200,
                content=body,
                headers={"content-encoding": "gzip", "connection": "x-hop", "x-hop": "1", "x-origin": "1"},
            )

        upstream = httpx.AsyncClient(transport=httpx.MockTransport(origin))
        to_origin = proxy_to("http://origin.test/base/", http_client=upstream)
        fac = MockFacilitator(radius_testnet)
        pay = radius_payments(network="testnet", pay_to=PAY_TO, facilitator=fac, routes={"POST /api/*": "$0.001"})
        app = Starlette(routes=[Route("/{path:path}", pay.wrap(to_origin), methods=["GET", "POST"])])

        free = asgi_client(app)
        redirect = await free.get("/redirect", headers={"Authorization": "Bearer keep"})
        assert redirect.status_code == 302 and redirect.headers["location"] == "/elsewhere"
        assert seen[0].headers["authorization"] == "Bearer keep"

        res = await buyer(app).post(
            "http://shop.test/api/echo?q=1", content=b"payload", headers={"Authorization": "Bearer keep"}
        )
        assert (res.status_code, res.text, res.headers.get("x-origin")) == (200, "origin says hi", "1")
        assert "content-encoding" not in res.headers and "x-hop" not in res.headers
        assert get_payment_receipt(res) is not None
        forwarded = seen[-1]
        assert (forwarded.method, forwarded.url.path, forwarded.url.query, forwarded.content) == (
            "POST",
            "/base/api/echo",
            b"q=1",
            b"payload",
        )
        assert "payment-signature" not in forwarded.headers
        assert forwarded.headers["authorization"] == "Bearer keep"
        assert forwarded.headers["accept-encoding"] == "identity"
        assert forwarded.headers["host"] == "origin.test"

    async def test_a_plain_handler_without_payment_runs_for_free_routes(self) -> None:
        pay = radius_payments(
            network="testnet",
            pay_to=PAY_TO,
            facilitator=MockFacilitator(radius_testnet),
            routes={"GET /paid": "$0.001"},
        )
        app = Starlette(routes=[Route("/free", pay.wrap(lambda request: PlainTextResponse("free")))])
        async with asgi_client(app) as http:
            assert (await http.get("/free")).text == "free"


async def test_proxy_to_keeps_the_origins_content_length_on_head() -> None:
    upstream = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, headers={"content-length": "1234"}))
    )
    to_origin = proxy_to("http://origin.test", http_client=upstream)
    app = Starlette(routes=[Route("/{path:path}", to_origin, methods=["GET", "HEAD"])])
    async with asgi_client(app) as http:
        res = await http.head("/file")
    assert res.headers["content-length"] == "1234"
