"""ASGI middleware that charges for routes with x402 payments (Radius by default).

The Python counterpart of ``radius-sdk/hono``: a thin wrapper over :func:`radius_sdk.server.radius_payments`
for a whole Starlette or FastAPI app::

    app = FastAPI()
    app.add_middleware(
        RadiusPaymentsMiddleware,
        network="testnet",
        pay_to="0xYourWallet",
        routes={"GET /api/lookup": {"price": "$0.001", "description": "One lookup"}},
    )

    @app.get("/api/lookup")
    async def lookup(request: Request):
        return {"paid_by": request.state.radius_payment.payer}

Dynamic ``pay_to`` / ``price`` and ``on_settled`` receive the Starlette ``Request``; paid handlers read
the receipt from ``request.state.radius_payment`` (when ``settle`` is 'before', the default). The
downstream app's response streams through in the 'before' flow; the 'after' flow buffers it to
settle on the finished response.
"""

from __future__ import annotations

import asyncio
from typing import Any

from starlette.requests import Request
from starlette.responses import Response, StreamingResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .receipt import PaymentReceipt
from .server import PaymentHandler, radius_payments

__all__ = ["RadiusPaymentsMiddleware", "run_app"]


async def run_app(app: ASGIApp, scope: Scope, receive: Receive) -> Response:
    """Run an ASGI app and return its response as a Starlette ``Response`` once its headers are sent.

    The body streams from the app as the returned response is sent. An exception before the app
    starts its response is raised here (the handler "threw").
    """
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    started: asyncio.Future[Message] = asyncio.get_running_loop().create_future()

    async def send(message: Message) -> None:
        if message["type"] == "http.response.start":
            if not started.done():
                started.set_result(message)
        elif message["type"] == "http.response.body":
            await queue.put(message.get("body", b""))
            if not message.get("more_body", False):
                await queue.put(None)

    async def run() -> None:
        try:
            await app(scope, receive, send)
        finally:
            await queue.put(None)

    task = asyncio.get_running_loop().create_task(run())
    await asyncio.wait([started, task], return_when=asyncio.FIRST_COMPLETED)  # type: ignore[type-var]
    if not started.done():
        task.result()  # raises the app's exception
        raise RuntimeError("radius-sdk: the app returned without sending a response")
    message = started.result()

    async def body() -> Any:
        while True:
            chunk = await queue.get()
            if chunk is None:
                break
            yield chunk
        await task

    response = StreamingResponse(body(), status_code=message["status"])
    response.raw_headers = list(message.get("headers", []))
    return response


class RadiusPaymentsMiddleware:
    """Pure ASGI middleware: ``app.add_middleware(RadiusPaymentsMiddleware, pay_to=..., routes=..., **options)``.

    Options are those of :func:`radius_sdk.server.radius_payments`. The handler is available as
    ``middleware.payments`` (``.radius`` is the :class:`~radius_sdk.server.RadiusServer`).
    """

    def __init__(self, app: ASGIApp, **options: Any) -> None:
        self.app = app
        self.payments: PaymentHandler = radius_payments(**options)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope, receive)
        if not self.payments.requires_payment(request):
            await self.app(scope, receive, send)
            return

        async def next(_request: Request, payment: PaymentReceipt | None) -> Response:
            if payment is not None:
                request.state.radius_payment = payment
            return await run_app(self.app, scope, receive)

        response = await self.payments(request, next)
        await response(scope, receive, send)
