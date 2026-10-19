"""Starlette seller with the Starlette handler: free ``/``, paid ``/api/lookup`` and ``/api/query``.

    RADIUS_PAY_TO=0xYourWallet uv run --extra server uvicorn examples.starlette_seller:app --port 8791

The same API as the TypeScript ``examples/worker-plain``; pay it with ``examples/buy.py`` or
``radius-cli wallet pay http://localhost:8791/api/lookup``.
"""

from __future__ import annotations

import os

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from radius_sdk import PaymentReceipt, radius_env
from radius_sdk.server import radius_payments

config = radius_env()
pay = radius_payments(
    **{"network": "testnet", **config},
    pay_to=config.get("pay_to") or os.environ.get("PAY_TO", "0x000000000000000000000000000000000000dEaD"),
    routes={
        "GET /api/lookup": {"price": "0.001", "description": "One lookup"},
        "POST /api/query": "0.01",
    },
    on_settled=lambda receipt, request: print(f"settled {receipt.amount} on {receipt.network}: {receipt.explorer_url}"),
)


async def index(request: Request) -> JSONResponse:
    return JSONResponse({"free": True, "paid": ["GET /api/lookup", "POST /api/query"]})


async def lookup(request: Request, payment: PaymentReceipt | None) -> JSONResponse:
    return JSONResponse(
        {"ip": request.query_params.get("ip", "1.2.3.4"), "country": "NZ", "paidBy": payment.payer if payment else None}
    )


async def query(request: Request, payment: PaymentReceipt | None) -> JSONResponse:
    return JSONResponse(
        {"query": (await request.body()).decode(), "rows": [], "tx": payment.transaction if payment else None}
    )


app = Starlette(
    routes=[
        Route("/", index),
        Route("/api/lookup", pay.wrap(lookup)),
        Route("/api/query", pay.wrap(query), methods=["POST"]),
    ]
)
