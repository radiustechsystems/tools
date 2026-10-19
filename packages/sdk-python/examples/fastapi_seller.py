"""FastAPI seller with the ASGI middleware, plus the validate-then-pay pattern for one route.

    RADIUS_PAY_TO=0xYourWallet uv run --extra server --with fastapi uvicorn examples.fastapi_seller:app --port 8792

The middleware charges ``GET /api/lookup`` and paid handlers read the receipt from
``request.state.radius_payment``. ``/articles/{slug}`` validates first and charges second, so a
missing article is a free 404, not a paid error (the default ``settle='before'`` moves funds before
the handler runs).
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, Request
from starlette.responses import JSONResponse, Response

from radius_sdk import radius_env
from radius_sdk.server import radius_payments
from radius_sdk.starlette import RadiusPaymentsMiddleware

config = {"network": "testnet", **radius_env()}
pay_to = config.pop("pay_to", None) or os.environ.get("PAY_TO", "0x000000000000000000000000000000000000dEaD")

app = FastAPI()
app.add_middleware(
    RadiusPaymentsMiddleware,
    **config,
    pay_to=pay_to,
    routes={"GET /api/lookup": {"price": "0.001", "description": "One lookup"}},
)


@app.get("/api/lookup")
async def lookup(request: Request) -> dict[str, Any]:
    payment = getattr(request.state, "radius_payment", None)
    return {"country": "NZ", "paidBy": payment.payer if payment else None}


ARTICLES = {"hello-radius": {"title": "Hello, Radius", "body": "Sub-second finality, stablecoin fees."}}
articles = radius_payments(
    **config, pay_to=pay_to, routes={"GET /articles/*": {"price": "0.002", "description": "One article"}}
)


@app.get("/articles/{slug}")
async def article(slug: str, request: Request) -> Response:
    found = ARTICLES.get(slug)
    if found is None:
        return JSONResponse({"error": "not found"}, status_code=404)  # nothing charged
    return await articles(request, lambda _request, _payment: JSONResponse(found))  # charge, then deliver
