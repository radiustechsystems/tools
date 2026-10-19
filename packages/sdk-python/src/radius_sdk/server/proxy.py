"""``proxy_to(origin)``: forward a request to an origin you do not change, for a seller in front of it."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit, urlunsplit

import httpx

if TYPE_CHECKING:
    from starlette.requests import Request
    from starlette.responses import Response

#: Hop-by-hop headers (RFC 9110 §7.6.1), plus ``expect``.
HOP_BY_HOP = ("connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "expect")
#: Codings httpx decodes when the body is read.
DECODED = {"gzip", "x-gzip", "deflate", "br"}
_TOKEN = re.compile(r"^[!#$%&'*+.^_`|~\w-]+\Z")


def _without_hop_by_hop(headers: list[tuple[str, str]]) -> list[tuple[str, str]]:
    named: set[str] = set()
    for k, v in headers:
        if k.lower() == "connection":
            named.update(n.strip().lower() for n in v.split(",") if _TOKEN.match(n.strip()))
    drop = named | set(HOP_BY_HOP)
    return [(k, v) for k, v in headers if k.lower() not in drop]


def proxy_to(origin: str, *, http_client: httpx.AsyncClient | None = None) -> Callable[..., Awaitable[Response]]:
    """A handler that sends each request to ``origin``, keeping its method, path (appended to the origin's path) and query.

    Free requests pass through as they are; paid ones arrive after the payment handler, with their
    payment credentials removed. Use it as the paid handler: ``pay.wrap(proxy_to(origin))``.

    - Request headers: drops ``host``, hop-by-hop headers and ``content-length``, and the payment
      credentials (``PAYMENT-SIGNATURE``, ``X-PAYMENT``, ``Authorization: Payment …``; other
      ``Authorization`` schemes are forwarded). Sends ``Accept-Encoding: identity``, and if the origin
      compresses anyway, drops the ``Content-Encoding`` and ``Content-Length`` that no longer match
      the body httpx decoded.
    - The body of a non-GET/HEAD request is buffered.
    - Redirects are returned, not followed. The response is a copy with mutable headers (minus
      hop-by-hop ones), so the payment handler can add its receipt.
    """
    base = urlsplit(origin)
    prefix = base.path.rstrip("/")
    client = http_client

    async def handler(request: Request, _payment: Any = None) -> Response:
        nonlocal client
        from starlette.responses import Response as StarletteResponse

        if client is None:
            client = httpx.AsyncClient(timeout=None)
        from .adapter import raw_path

        # Never resolved against the path: `//host/x` stays on origin.
        target = urlunsplit((base.scheme, base.netloc, prefix + raw_path(request), request.url.query, ""))
        headers = _without_hop_by_hop(list(request.headers.items()))
        drop = {"host", "content-length", "payment-signature", "x-payment", "accept-encoding"}
        headers = [
            (k, v)
            for k, v in headers
            if k.lower() not in drop
            and not (k.lower() == "authorization" and re.match(r"^payment\s", v, re.IGNORECASE))
        ]
        headers.append(("accept-encoding", "identity"))
        body = None if request.method in ("GET", "HEAD") else await request.body()
        # Built directly, not with client.build_request: httpx would attach cookies its jar picked up from the
        # origin's answers to other buyers. fetch has no cookie jar, and neither does this proxy.
        res = await client.send(
            httpx.Request(request.method, target, headers=headers, content=body), follow_redirects=False
        )
        out = _without_hop_by_hop(list(res.headers.multi_items()))
        codings = [c.strip().lower() for c in res.headers.get("content-encoding", "").split(",") if c.strip()]
        if codings and all(c in DECODED for c in codings):
            out = [(k, v) for k, v in out if k.lower() not in ("content-encoding", "content-length")]
        response = StarletteResponse(content=res.content, status_code=res.status_code)
        # A HEAD answer has no body but keeps the origin's Content-Length; anything else gets the buffered body's.
        keep_length = request.method == "HEAD"
        response.raw_headers = [
            (k.lower().encode("latin-1"), v.encode("latin-1"))
            for k, v in out
            if keep_length or k.lower() != "content-length"
        ]
        if not keep_length:
            response.headers["content-length"] = str(len(res.content))
        return response

    return handler
