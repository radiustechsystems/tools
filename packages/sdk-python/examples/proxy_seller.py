"""Charge for an origin you do not change (any language): the paid handler forwards to it.

ORIGIN=http://localhost:3000 RADIUS_PAY_TO=0xYourWallet uv run --extra server uvicorn examples.proxy_seller:app --port 8793
"""

from __future__ import annotations

import os

from starlette.applications import Starlette
from starlette.routing import Route

from radius_sdk import radius_env
from radius_sdk.server import proxy_to, radius_payments

config = radius_env()
pay = radius_payments(
    **{"network": "testnet", **config},
    pay_to=config.get("pay_to") or os.environ.get("PAY_TO", "0x000000000000000000000000000000000000dEaD"),
    routes={"GET /api/*": "0.001"},
)
to_origin = proxy_to(os.environ.get("ORIGIN", "http://localhost:3000"))

# Paid routes are charged, then proxied; everything else is proxied for free.
app = Starlette(routes=[Route("/{path:path}", pay.wrap(to_origin), methods=["GET", "POST", "PUT", "DELETE", "HEAD"])])
