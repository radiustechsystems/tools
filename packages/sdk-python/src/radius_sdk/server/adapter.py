"""x402 ``HTTPAdapter`` over a Starlette (ASGI) request, the Python counterpart of a web-standard ``Request``."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from urllib.parse import unquote

from x402.http.types import HTTPRequestContext

if TYPE_CHECKING:
    from starlette.requests import Request


class RequestAdapter:
    """x402 ``HTTPAdapter`` over a Starlette ``Request``. Works for Starlette, FastAPI and anything built on them."""

    def __init__(self, request: Request) -> None:
        self.request = request

    def get_header(self, name: str) -> str | None:
        return self.request.headers.get(name)

    def get_method(self) -> str:
        return self.request.method

    def get_path(self) -> str:
        return raw_path(self.request)

    def get_url(self) -> str:
        return str(self.request.url)

    def get_accept_header(self) -> str:
        return self.request.headers.get("accept", "")

    def get_user_agent(self) -> str:
        return self.request.headers.get("user-agent", "")

    def get_query_params(self) -> dict[str, str | list[str]]:
        out: dict[str, str | list[str]] = {}
        for key, value in self.request.query_params.multi_items():
            existing = out.get(key)
            if existing is None:
                out[key] = value
            elif isinstance(existing, list):
                existing.append(value)
            else:
                out[key] = [existing, value]
        return out

    def get_query_param(self, name: str) -> str | list[str] | None:
        values = self.request.query_params.getlist(name)
        if not values:
            return None
        return values[0] if len(values) == 1 else values

    def get_body(self) -> Any:
        # The body is async in ASGI and belongs to the handler; x402 only reads it for discovery extensions.
        return None


def raw_path(request: Request) -> str:
    """The request path as sent (percent-encoded), like a web-standard ``URL.pathname``."""
    raw = request.scope.get("raw_path")
    if isinstance(raw, (bytes, bytearray)):
        path = raw.decode("latin-1").split("?", 1)[0]
    else:
        path = request.url.path
    root = request.scope.get("root_path") or ""
    if root and path.startswith(root) and (len(path) == len(root) or path[len(root)] == "/"):
        path = path[len(root) :] or "/"
    return path


def _decode_path(path: str) -> str | None:
    try:
        return unquote(path, errors="strict")
    except UnicodeDecodeError:
        return None


def request_context(request: Request) -> HTTPRequestContext:
    """The x402 request context for a Starlette ``Request``."""
    adapter = RequestAdapter(request)
    path = adapter.get_path()
    return HTTPRequestContext(
        adapter=adapter,
        path=path,
        decoded_path=_decode_path(path),
        method=request.method,
        payment_header=adapter.get_header("payment-signature") or adapter.get_header("x-payment"),
    )


def request_of(context: HTTPRequestContext | None) -> Request | None:
    """The Starlette ``Request`` behind an x402 request context, when this SDK's adapter produced it."""
    adapter = getattr(context, "adapter", None)
    return adapter.request if isinstance(adapter, RequestAdapter) else None
