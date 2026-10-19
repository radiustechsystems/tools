"""Regression tests for divergences from the TypeScript SDK found in review."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Mount, Route

from helpers import PAY_TO, PK, MockFacilitator, asgi_client, from_b64
from radius_sdk import radius_testnet
from radius_sdk.mpp import MppChallenge, encode_request, mpp_challenge_id, serialize_mpp_challenge
from radius_sdk.server import RadiusFacilitatorClient, proxy_to, radius_payments
from test_client_parity import EXACT_EIP3009, UPTO, pay, receipt_response, rejects, v2


async def test_proxy_to_never_carries_one_buyers_origin_cookies_to_another() -> None:
    seen: list[str | None] = []

    def origin(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("cookie"))
        return httpx.Response(200, text="ok", headers={"set-cookie": "session=ALICE; Path=/"})

    to_origin = proxy_to("http://origin.test", http_client=httpx.AsyncClient(transport=httpx.MockTransport(origin)))
    app = Starlette(routes=[Route("/{path:path}", to_origin)])
    async with asgi_client(app) as http:
        await http.get("/a")
        http.cookies.clear()
        await http.get("/b")
    assert seen == [None, None]


async def test_the_buyer_keeps_no_cookie_jar_between_requests() -> None:
    seen: list[str | None] = []

    def seller(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("cookie"))
        return httpx.Response(200, headers={"set-cookie": "tracker=1; Path=/"})

    from radius_sdk.client import create_radius_fetch

    client = create_radius_fetch(network="testnet", signer=PK, max_per_request="$0.01")
    client._http._transport = httpx.MockTransport(seller)  # the default client, cookie policy and all
    await client("http://shop.test/a")
    await client("http://shop.test/b")
    assert seen == [None, None]


async def test_a_mounted_app_matches_routes_on_the_full_path() -> None:
    pay = radius_payments(
        network="testnet",
        pay_to=PAY_TO,
        facilitator=MockFacilitator(radius_testnet),
        routes={"GET /v1/api/lookup": "$0.001"},
    )
    inner = Starlette(routes=[Route("/api/lookup", pay.wrap(lambda r: PlainTextResponse("secret")))])
    async with asgi_client(Starlette(routes=[Mount("/v1", inner)])) as http:
        res = await http.get("/v1/api/lookup")
    assert res.status_code == 402
    assert from_b64(res.headers["payment-required"])["resource"]["url"].endswith("/v1/api/lookup")


async def test_a_sub_second_window_stays_within_the_cap() -> None:
    now = int(time.time())
    r = await pay(v2({**EXACT_EIP3009, "maxTimeoutSeconds": 0.5}))
    assert int(r["decoded"]["payload"]["authorization"]["validBefore"]) <= now + 2
    p = await pay(v2({**UPTO, "maxTimeoutSeconds": 0.5}))
    assert int(p["decoded"]["payload"]["permit2Authorization"]["deadline"]) <= now + 2


async def test_settle_after_keeps_the_handlers_background_task() -> None:
    ran: list[bool] = []
    pay_handler = radius_payments(
        network="testnet",
        pay_to=PAY_TO,
        facilitator=MockFacilitator(radius_testnet),
        settle="after",
        routes={"GET /x": "$0.001"},
    )
    app = Starlette(
        routes=[
            Route(
                "/x",
                pay_handler.wrap(
                    lambda r: JSONResponse({"ok": True}, background=BackgroundTask(lambda: ran.append(True)))
                ),
            )
        ]
    )
    from radius_sdk.client import create_radius_fetch

    res = await create_radius_fetch(
        network="testnet", signer=PK, max_per_request="$0.01", http_client=asgi_client(app)
    )("http://shop.test/x")
    assert res.status_code == 200 and ran == [True]


async def test_untrusted_amounts_with_a_trailing_newline_or_null_are_refused() -> None:
    full = {"success": True, "transaction": "0xabc", "network": "eip155:84532"}
    for bad in ("5\n", None):
        await rejects(pay(v2(UPTO), paid=receipt_response({**full, "amount": bad})), "invalid_receipt")
    c = MppChallenge(
        id="",
        realm="r",
        method="evm",
        intent="charge",
        expires="2030-01-01T00:00:00.000Z",
        request={},
        request_encoded="",
    )
    c.request = {
        "amount": "10000\n",
        "currency": radius_testnet.asset.address,
        "recipient": PAY_TO,
        "methodDetails": {"chainId": 72344, "credentialTypes": ["authorization"]},
    }
    c.request_encoded = encode_request(c.request)
    c.id = mpp_challenge_id("s" * 32, c)
    transport = httpx.MockTransport(
        lambda _r: httpx.Response(402, headers={"WWW-Authenticate": serialize_mpp_challenge(c)})
    )
    from radius_sdk.client import create_radius_fetch

    client = create_radius_fetch(
        network="testnet",
        signer=PK,
        max_per_request="$0.05",
        protocols=["mpp"],
        http_client=httpx.AsyncClient(transport=transport),
    )
    await rejects(client("http://shop.test/x"), "invalid_challenge")


async def test_a_non_object_extra_is_treated_as_absent() -> None:
    r = await pay(v2({**EXACT_EIP3009, "extra": "eip3009"}))
    assert r["res"].status_code == 200
    assert "authorization" in r["decoded"]["payload"]


def test_the_facilitator_client_follows_the_running_loop_and_closes() -> None:
    fac = RadiusFacilitatorClient(radius_testnet)

    async def client() -> Any:
        return fac._async()

    first = asyncio.run(client())
    second = asyncio.run(client())
    assert first is not second
    asyncio.run(fac.aclose())
    assert fac._http is None
