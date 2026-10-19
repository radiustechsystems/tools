"""Accept payments: x402 v2 (and optionally MPP) for any ASGI stack, on Radius by default.

- :func:`radius_payments` returns a :class:`PaymentHandler` for Starlette requests: wrap an endpoint
  with ``pay.wrap(endpoint)``, or call ``await pay(request, next)`` from your own route. For whole-app
  middleware use :class:`radius_sdk.starlette.RadiusPaymentsMiddleware`.
- :class:`RadiusServer` holds the x402 resource server (a scheme and facilitator per network,
  gas-sponsoring rules). ``server`` + :meth:`RadiusServer.routes` plug into the upstream x402
  middleware (``x402.http.middleware.fastapi`` / ``flask``).

Standard x402 v2 on the wire: unpaid requests get a 402 with a ``PAYMENT-REQUIRED`` header; paid
requests carry ``PAYMENT-SIGNATURE``, are verified and settled through the facilitator, and get a
``PAYMENT-RESPONSE`` header back. A port of the TypeScript SDK's ``radius-sdk/server``.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Union

from x402 import x402ResourceServer
from x402.http import x402HTTPResourceServer
from x402.http.constants import SETTLEMENT_OVERRIDES_HEADER
from x402.http.facilitator_client_base import FacilitatorResponseError
from x402.http.types import (
    HTTPRequestContext,
    HTTPResponseInstructions,
    HTTPTransportContext,
    PaymentOption,
    RouteConfig,
)
from x402.http.x402_http_server_base import with_private_cache_control
from x402.schemas import AssetAmount, SettleResponse, SupportedResponse, VerifiedPaymentCancelOptions

from ..amounts import Price, resolve_price
from ..networks import (
    NetworkInput,
    PaymentAsset,
    PaymentNetwork,
    explorer_tx_url,
    is_network_id,
    overrides_of,
    resolve_network,
)
from ..receipt import PaymentReceipt
from .adapter import RequestAdapter, request_context, request_of
from .facilitator import (
    FacilitatorClient,
    FacilitatorOptions,
    RadiusFacilitatorClient,
    UnknownOutcome,
    current_unknown_outcome,
    static_supported,
    with_unknown_outcomes,
)
from .mpp import MPP_RECEIPT_HEADER, MppFailure, MppPayments, MppServerOptions, MppVerified
from .proxy import proxy_to
from .scheme import EIP2612_GAS_SPONSORING, GasSponsoringMode, RadiusExactScheme, SettleMode

if TYPE_CHECKING:
    from starlette.requests import Request
    from starlette.responses import Response

logger = logging.getLogger("radius_sdk")
_PAYMENT_AUTH = re.compile(r"^payment\s", re.IGNORECASE)

PayTo = Union[str, Callable[[Any], str | Awaitable[str]]]
"""Recipient address, or a function of the request (sync or async)."""


@dataclass(frozen=True)
class RouteSpec:
    """A paid route."""

    #: "$0.01", "0.01", 0.01 (USD, converted for each network's stablecoin), {"amount": "10000"} atomic
    #: units of each network's asset, or a function of the request returning one (sync or async).
    price: Price | Callable[[Any], Any]
    description: str | None = None
    mime_type: str | None = None
    #: Seconds the signed payment stays valid. Default 300.
    max_timeout_seconds: int | None = None
    #: Per-route recipient override.
    pay_to: PayTo | None = None


RouteSpecs = Mapping[str, RouteSpec | Price | Mapping[str, Any]]
"""Protected routes keyed "METHOD /path" (``*`` wildcards allowed, e.g. "GET /api/*"). A bare price is shorthand for ``RouteSpec(price)``."""


@dataclass(frozen=True)
class ServerNetwork:
    """One network a server accepts payment on, with the facilitator that settles it."""

    network: NetworkInput
    #: Defaults to the network's facilitator (Radius's on Radius, x402.org on Base Sepolia); required on Base.
    facilitator: FacilitatorOptions | Mapping[str, Any] | FacilitatorClient | None = None


GAS_SPONSORING_DECLARATION: dict[str, Any] = {
    "eip2612GasSponsoring": {
        "info": {
            "description": "The facilitator accepts EIP-2612 gasless Permit to `Permit2` canonical contract.",
            "version": "1",
        },
        "schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "from": {"type": "string", "pattern": "^0x[a-fA-F0-9]{40}$"},
                "asset": {"type": "string", "pattern": "^0x[a-fA-F0-9]{40}$"},
                "spender": {"type": "string", "pattern": "^0x[a-fA-F0-9]{40}$"},
                "amount": {"type": "string", "pattern": "^[0-9]+$"},
                "nonce": {"type": "string", "pattern": "^[0-9]+$"},
                "deadline": {"type": "string", "pattern": "^[0-9]+$"},
                "signature": {"type": "string", "pattern": "^0x[a-fA-F0-9]+$"},
                "version": {"type": "string", "pattern": "^[0-9]+(\\.[0-9]+)*$"},
            },
            "required": ["from", "asset", "spender", "amount", "nonce", "deadline", "signature", "version"],
        },
    }
}


def _is_facilitator_client(v: Any) -> bool:
    return callable(getattr(v, "settle", None)) and callable(getattr(v, "get_supported", None))


class _ScopedFacilitator:
    """A facilitator that reports only ``network``'s kinds.

    The x402 core routes each network to the first facilitator listing it, so without this a
    facilitator configured for one network (e.g. a multi-chain one for Base) could capture another
    network that has its own. It also records the facilitator's extensions on the network's scheme.
    """

    def __init__(
        self, network: PaymentNetwork, facilitator: Any, scheme: RadiusExactScheme, failures: dict[str, str]
    ) -> None:
        self.network = network
        self.inner = facilitator
        self.scheme = scheme
        self.failures = failures

    async def verify(self, payload: Any, requirements: Any) -> Any:
        return await self.inner.verify(payload, requirements)

    async def settle(self, payload: Any, requirements: Any) -> Any:
        return await self.inner.settle(payload, requirements)

    async def aclose(self) -> None:
        close = getattr(self.inner, "aclose", None)
        if close is not None:
            await close()

    def get_supported(self) -> SupportedResponse:
        try:
            supported = self.inner.get_supported()
        except Exception as e:
            self.failures[self.network.name] = str(e)
            raise
        self.failures.pop(self.network.name, None)
        self.scheme.facilitator_extensions = list(supported.extensions or [])
        return supported.model_copy(update={"kinds": [k for k in supported.kinds if k.network == self.network.network]})


def to_receipt(r: SettleResponse, network: PaymentNetwork, requirements: Any) -> PaymentReceipt:
    """Turn a facilitator settle result into the receipt handed to application code."""
    transaction = r.transaction or None
    amount = getattr(r, "amount", None)
    return PaymentReceipt(
        success=r.success,
        protocol="x402",
        transaction=transaction,
        network=r.network,
        payer=r.payer,
        # `exact` settles precisely the requested amount; facilitators only report `amount` for
        # schemes (like `upto`) where it can differ.
        amount=amount if amount is not None else (requirements.amount if r.success else None),
        error_reason=r.error_reason,
        error_message=r.error_message,
        explorer_url=explorer_tx_url(network, transaction) if transaction else None,
    )


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


class RadiusServer:
    """x402 payments for any HTTP stack, on Radius by default and optionally other networks.

    Holds the x402 resource server independently of how requests arrive: ``server`` + :meth:`routes`
    for the upstream x402 middleware, :meth:`handler` for Starlette requests.
    """

    def __init__(
        self,
        *,
        network: NetworkInput | None = None,
        networks: Sequence[NetworkInput | ServerNetwork] | None = None,
        facilitator: FacilitatorOptions | Mapping[str, Any] | FacilitatorClient | None = None,
        settle: SettleMode = "before",
        mpp: MppServerOptions | Mapping[str, Any] | None = None,
        gas_sponsoring: GasSponsoringMode = "auto",
        on_settled: Callable[[PaymentReceipt, HTTPRequestContext | None], Any] | None = None,
        rpc_url: str | None = None,
        facilitator_url: str | None = None,
        explorer_url: str | None = None,
        faucet_url: str | None = None,
        asset: Mapping[str, Any] | PaymentAsset | None = None,
        signer: Any = None,
        max_per_request: Any = None,
    ) -> None:
        # `signer` and `max_per_request` are buyer options: accepted (and ignored) so `**radius_env()` spreads cleanly.
        del signer, max_per_request
        if network is not None and networks is not None:
            raise ValueError("radius-sdk: pass network or networks, not both")
        if networks is not None and len(networks) == 0:
            raise ValueError("radius-sdk: networks is empty")
        if settle not in ("before", "after"):
            raise ValueError(f"radius-sdk: settle must be 'before' or 'after' (got {settle!r})")
        inputs: Sequence[NetworkInput | ServerNetwork | None] = networks if networks is not None else [network]
        entries = [e if isinstance(e, ServerNetwork) else ServerNetwork(network=e) for e in inputs]  # type: ignore[arg-type]
        overrides = overrides_of(
            rpc_url=rpc_url,
            facilitator_url=facilitator_url,
            explorer_url=explorer_url,
            faucet_url=faucet_url,
            asset=asset,
        )
        self._supported_failures: dict[str, str] = {}
        configured: list[tuple[PaymentNetwork, Any, RadiusExactScheme]] = []
        for i, entry in enumerate(entries):
            net = resolve_network(entry.network, overrides) if i == 0 else resolve_network(entry.network)
            choice = entry.facilitator if entry.facilitator is not None else (facilitator if i == 0 else None)
            base = choice if _is_facilitator_client(choice) else RadiusFacilitatorClient(net, choice)  # type: ignore[arg-type]
            scheme = RadiusExactScheme(net, settle, gas_sponsoring)
            configured.append(
                (net, _ScopedFacilitator(net, with_unknown_outcomes(base), scheme, self._supported_failures), scheme)
            )
        if len({c[0].chain_id for c in configured}) != len(configured):
            raise ValueError("radius-sdk: a network is listed twice")
        schemes = tuple(c[2] for c in configured)
        for s in schemes:
            s.peers = schemes

        #: Every network routes offer payment on, in offer order.
        self.networks: tuple[PaymentNetwork, ...] = tuple(c[0] for c in configured)
        #: The first (or only) network.
        self.network: PaymentNetwork = self.networks[0]
        #: The first network's facilitator, wrapped so calls that fail without its own answer surface as 502.
        self.facilitator = configured[0][1]
        #: The first network's scheme.
        self.scheme: RadiusExactScheme = configured[0][2]
        self.settle_mode: SettleMode = settle
        self._facilitators = {c[0].network: c[1] for c in configured}
        #: The x402 resource server, for upstream framework middleware.
        self.server = x402ResourceServer([c[1] for c in configured])
        for net, _f, scheme in configured:
            self.server.register(net.network, scheme)  # type: ignore[arg-type]
        self._settled_hooks: list[Callable[[PaymentReceipt, HTTPRequestContext | None], Any]] = []
        #: MPP alongside x402, when ``mpp`` is configured.
        self.mpp: MppPayments | None = (
            MppPayments(self, dict(mpp) if isinstance(mpp, Mapping) else mpp) if mpp else None
        )
        if on_settled:
            self.on_settled(on_settled)

    async def aclose(self) -> None:
        """Close the facilitator HTTP clients the server created (call on application shutdown)."""
        for f in self._facilitators.values():
            await f.aclose()

    def unsupported_networks(self) -> str | None:
        """Why some networks' facilitators could not be reached for ``/supported``, if any did not answer."""
        if not self._supported_failures:
            return None
        return "; ".join(f"{name}: {error}" for name, error in self._supported_failures.items())

    def network_for(self, id: str | None) -> PaymentNetwork:
        """The configured network a CAIP-2 id (or x402 v1 name) refers to; the first network if none matches."""
        if id is not None:
            for n in self.networks:
                if is_network_id(n, id):
                    return n
        return self.network

    def on_settled(self, hook: Callable[[PaymentReceipt, HTTPRequestContext | None], Any]) -> RadiusServer:
        """Register a settlement listener.

        Records settlement, not delivery: with ``settle='before'`` it fires before the handler runs, and
        the handler may still fail. Errors raised here are logged, not surfaced to the buyer.
        """
        if not self._settled_hooks:

            async def after_settle(ctx: Any) -> None:
                if not ctx.result.success:
                    return
                transport = getattr(ctx, "transport_context", None)
                receipt = to_receipt(ctx.result, self.network_for(ctx.requirements.network), ctx.requirements)
                await self.notify_settled(receipt, getattr(transport, "request", None))

            self.server.on_after_settle(after_settle)
        self._settled_hooks.append(hook)
        return self

    async def notify_settled(self, receipt: PaymentReceipt, context: HTTPRequestContext | None) -> None:
        """Run every settlement listener, each isolated: one that raises is logged and the rest still run."""
        for hook in self._settled_hooks:
            try:
                await _maybe_await(hook(receipt, context))
            except Exception:
                logger.exception("radius-sdk on_settled hook failed")

    def facilitator_for(self, network: PaymentNetwork) -> Any:
        """The facilitator (wrapped, see ``facilitator``) that settles payments on ``network``."""
        f = self._facilitators.get(network.network)
        if f is None:
            raise ValueError(f"radius-sdk: {network.name} is not one of this server's networks")
        return f

    def routes(self, *, pay_to: PayTo, routes: RouteSpecs) -> dict[str, RouteConfig]:
        """x402 ``RoutesConfig``: one payment option per network and the gas-sponsoring declaration.

        Dynamic ``pay_to`` / ``price`` receive the x402 ``HTTPRequestContext``.
        """
        return self.build_routes(pay_to=pay_to, routes=routes, context_of=lambda ctx: ctx)

    def build_routes(
        self, *, pay_to: PayTo, routes: RouteSpecs, context_of: Callable[[HTTPRequestContext], Any]
    ) -> dict[str, RouteConfig]:
        """:meth:`routes` with dynamic functions receiving a framework-specific context."""
        networks = self.networks

        def normalise(p: Any, network: PaymentNetwork) -> AssetAmount:
            if len(networks) > 1 and isinstance(p, Mapping) and p.get("asset") is not None:
                raise ValueError(
                    "radius-sdk: a price naming an asset cannot apply to several networks; give a USD price or an atomic amount without asset"
                )
            resolved = resolve_price(p, network.asset)
            return AssetAmount(amount=resolved["amount"], asset=resolved["asset"], extra={})

        def dynamic_pay_to(spec: PayTo) -> Any:
            if not callable(spec):
                return spec

            def resolve(ctx: HTTPRequestContext) -> Any:
                return spec(context_of(ctx))

            return resolve

        def price_for(price: Any, network: PaymentNetwork) -> Any:
            if not callable(price):
                return normalise(price, network)

            def resolve(ctx: HTTPRequestContext) -> Any:
                value = price(context_of(ctx))
                if inspect.isawaitable(value):

                    async def later() -> AssetAmount:
                        return normalise(await value, network)

                    return later()
                return normalise(value, network)

            return resolve

        out: dict[str, RouteConfig] = {}
        for pattern, spec_or_price in routes.items():
            spec = _route_spec(spec_or_price)
            route_pay_to = dynamic_pay_to(spec.pay_to if spec.pay_to is not None else pay_to)
            accepts = [
                PaymentOption(
                    scheme="exact",
                    network=network.network,
                    pay_to=route_pay_to,
                    price=price_for(spec.price, network),
                    max_timeout_seconds=spec.max_timeout_seconds or 300,
                )
                for network in networks
            ]
            out[pattern] = RouteConfig(
                accepts=accepts[0] if len(accepts) == 1 else accepts,
                description=spec.description,
                mime_type=spec.mime_type,
                extensions={k: dict(v) for k, v in GAS_SPONSORING_DECLARATION.items()},
            )
        return out

    def http(self, *, pay_to: PayTo, routes: RouteSpecs) -> x402HTTPResourceServer:
        """An ``x402HTTPResourceServer`` for these routes."""
        return x402HTTPResourceServer(self.server, self.routes(pay_to=pay_to, routes=routes))

    def handler(self, *, pay_to: PayTo, routes: RouteSpecs) -> PaymentHandler:
        """Starlette handler for these routes; dynamic ``pay_to`` / ``price`` receive the ``Request``."""
        return create_payment_handler(
            self, self.build_routes(pay_to=pay_to, routes=routes, context_of=_request_or_raise)
        )


def _route_spec(value: Any) -> RouteSpec:
    if isinstance(value, RouteSpec):
        return value
    if isinstance(value, Mapping) and "price" in value:
        names = {
            "price",
            "description",
            "mime_type",
            "mimeType",
            "max_timeout_seconds",
            "maxTimeoutSeconds",
            "pay_to",
            "payTo",
        }
        unknown = set(value) - names
        if unknown:
            raise ValueError(f"radius-sdk: unknown route options {sorted(unknown)}")
        return RouteSpec(
            price=value["price"],
            description=value.get("description"),
            mime_type=value.get("mime_type", value.get("mimeType")),
            max_timeout_seconds=value.get("max_timeout_seconds", value.get("maxTimeoutSeconds")),
            pay_to=value.get("pay_to", value.get("payTo")),
        )
    return RouteSpec(price=value)


def _request_or_raise(ctx: HTTPRequestContext) -> Request:
    request = request_of(ctx)
    if request is None:
        raise RuntimeError("radius-sdk: request context was not produced by RequestAdapter")
    return request


def create_radius_server(**options: Any) -> RadiusServer:
    return RadiusServer(**options)


NextHandler = Callable[..., Any]
"""The application handler behind a paid route: ``(request, payment) -> Response`` (sync or async).

``payment`` is the receipt when settlement ran before the handler (``settle='before'``, the default).
A handler taking only ``request`` works too."""


def radius_payments(
    *,
    pay_to: PayTo,
    routes: RouteSpecs,
    on_settled: Callable[[PaymentReceipt, Request], Any] | None = None,
    **server_options: Any,
) -> PaymentHandler:
    """Charge for routes with x402 payments (Radius by default; add networks with ``networks``)::

        pay = radius_payments(network="testnet", pay_to="0x…", routes={"GET /api/lookup": "$0.001"})

        async def lookup(request, payment):
            return JSONResponse({"paid_by": payment.payer if payment else None})

        app = Starlette(routes=[Route("/api/lookup", pay.wrap(lookup))])

    Keyword arguments are those of :class:`RadiusServer`: ``network`` / ``networks``,
    ``facilitator``, ``settle``, ``mpp``, ``gas_sponsoring`` and the network overrides.
    """
    radius = RadiusServer(
        **server_options,
        on_settled=(lambda receipt, ctx: on_settled(receipt, _request_or_raise(ctx))) if on_settled else None,  # type: ignore[arg-type]
    )
    return radius.handler(pay_to=pay_to, routes=routes)


# -- responses ----------------------------------------------------------------------------------


def _json_response(body: Any, status: int) -> Response:
    from starlette.responses import JSONResponse

    return JSONResponse(body, status_code=status)


def _instructions_to_response(r: HTTPResponseInstructions | None) -> Response:
    from starlette.responses import HTMLResponse

    if r is None:
        return _json_response({}, 402)
    res = HTMLResponse(str(r.body or ""), status_code=r.status) if r.is_html else _json_response(r.body or {}, r.status)
    for k, v in (r.headers or {}).items():
        if k.lower() == "content-type":
            continue  # the body's own type, set above
        res.headers[k] = v
    return res


def _facilitator_error_response(error: Exception | str) -> Response:
    return _json_response({"error": "facilitator_error", "message": str(error)}, 502)


def _internal_error_response(error: Exception) -> Response:
    return _json_response({"error": "payment_processing_error", "message": str(error)}, 500)


def _error_response(error: Exception) -> Response:
    return (
        _facilitator_error_response(error)
        if isinstance(error, FacilitatorResponseError)
        else _internal_error_response(error)
    )


def _set_headers(res: Response, headers: Mapping[str, str] | None) -> None:
    for k, v in (headers or {}).items():
        res.headers[k] = v


async def read_body(res: Response) -> bytes:
    """The whole body of a Starlette response, consuming a streaming one."""
    body = getattr(res, "body", None)
    if isinstance(body, (bytes, bytearray, memoryview)):
        return bytes(body)
    chunks: list[bytes] = []
    async for chunk in res.body_iterator:  # type: ignore[attr-defined]
        chunks.append(
            bytes(chunk)
            if isinstance(chunk, (bytes, bytearray))
            else str(chunk).encode(getattr(res, "charset", "utf-8"))
        )
    return b"".join(chunks)


def _with_body(res: Response, body: bytes) -> Response:
    from starlette.responses import Response as StarletteResponse

    out = StarletteResponse(content=body, status_code=res.status_code)
    out.raw_headers = [(k, v) for k, v in res.raw_headers if k.lower() != b"content-length"]
    out.headers["content-length"] = str(len(body))
    out.background = res.background
    return out


def _accepts_payment(fn: Callable[..., Any]) -> bool:
    try:
        params = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):
        return True
    positional = [p for p in params if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
    return len(positional) >= 2 or any(p.kind == p.VAR_POSITIONAL for p in params)


async def _call_next(next: NextHandler, request: Request, payment: PaymentReceipt | None) -> Response:
    result = next(request, payment) if _accepts_payment(next) else next(request)
    return await _maybe_await(result)


class PaymentHandler:
    """Charge for a request if it matches a paid route, then call ``next`` (or answer 402 / errors)."""

    def __init__(self, radius: RadiusServer, routes: dict[str, RouteConfig]) -> None:
        self.radius = radius
        self.http_server = x402HTTPResourceServer(radius.server, routes)
        self._initialized = False
        self._init_lock: asyncio.Lock | None = None

    def requires_payment(self, request: Request) -> bool:
        """True when ``request`` matches a paid route (cheap, no network)."""
        return self.http_server.requires_payment(request_context(request))

    def wrap(self, next: NextHandler) -> Callable[[Request], Awaitable[Response]]:
        """``handler => request => Response``: a Starlette endpoint that charges, then runs ``next``."""

        async def endpoint(request: Request) -> Response:
            return await self(request, next)

        endpoint.__name__ = getattr(next, "__name__", "endpoint")
        return endpoint

    async def _ensure_initialized(self) -> None:
        # Lazy, request-time initialisation off the event loop (the x402 core's initialize() is
        # synchronous). A failure is not cached: the next request tries again. When it failed because
        # a facilitator's /supported did, answer 502 rather than 500.
        if self._initialized:
            return
        if self._init_lock is None:
            self._init_lock = asyncio.Lock()
        async with self._init_lock:
            if self._initialized:
                return
            try:
                await asyncio.to_thread(self.http_server.initialize)
            except Exception as e:
                unreachable = self.radius.unsupported_networks()
                if unreachable:
                    raise FacilitatorResponseError(unreachable) from e
                raise
            self._initialized = True

    async def __call__(self, request: Request, next: NextHandler) -> Response:
        context = request_context(request)
        if not self.http_server.requires_payment(context):
            return await _call_next(next, request, None)

        try:
            await self._ensure_initialized()
        except Exception as error:
            return _error_response(error)

        slot = UnknownOutcome()
        token = current_unknown_outcome.set(slot)
        try:
            return await self._handle(request, context, next, slot)
        finally:
            current_unknown_outcome.reset(token)

    async def _handle(
        self, request: Request, context: HTTPRequestContext, next: NextHandler, slot: UnknownOutcome
    ) -> Response:
        radius = self.radius
        http_server = self.http_server
        try:
            result = await http_server.process_http_request(context)
        except Exception as error:
            return _error_response(error)
        if slot.error is not None:
            return _facilitator_error_response(slot.error)

        if result.type == "no-payment-required":
            return await _call_next(next, request, None)
        if result.type == "payment-error":
            res = _instructions_to_response(result.response)
            mpp = radius.mpp
            if mpp is None or res.status_code != 402:
                return res
            # No x402 payment: an MPP credential is checked against the offers this 402 lists;
            # otherwise the 402 also offers MPP.
            if not context.payment_header and _PAYMENT_AUTH.match(request.headers.get("authorization") or ""):
                return await self._handle_mpp(request, context, res, next)
            return mpp.add_challenges(request, res)

        payload = result.payment_payload
        requirements = result.payment_requirements
        assert payload is not None and requirements is not None  # set on every "payment-verified" result
        before = result.before_handler_settlement
        dispatcher = result.cancellation_dispatcher
        payment = to_receipt(before.result, radius.network_for(requirements.network), requirements) if before else None

        try:
            res = await _call_next(next, request, payment)
        except Exception as error:
            cancel = (
                await dispatcher.cancel(VerifiedPaymentCancelOptions(reason="handler_threw", error=error))
                if dispatcher
                else None
            )
            if before is None and cancel is None:
                raise
            failure = _internal_error_response(error)
            _set_headers(
                failure,
                http_server.create_failure_path_settlement_headers(
                    cancel, before, payload, failure.headers.get("cache-control")
                ),
            )
            return failure

        if res.status_code >= 400:
            cancel = (
                await dispatcher.cancel(
                    VerifiedPaymentCancelOptions(reason="handler_failed", response_status=res.status_code)
                )
                if dispatcher
                else None
            )
            if SETTLEMENT_OVERRIDES_HEADER in res.headers:
                del res.headers[SETTLEMENT_OVERRIDES_HEADER]
            _set_headers(
                res,
                http_server.create_failure_path_settlement_headers(
                    cancel, before, payload, res.headers.get("cache-control")
                ),
            )
            return res

        # Settlement already happened in the 'before' flow: core only echoes its headers, so the
        # handler's body streams through untouched. The 'after' flow settles on the finished response
        # and needs the body in hand.
        if before is None:
            res = _with_body(res, await read_body(res))
        response_headers = dict(res.headers.items())
        overrides = http_server._extract_settlement_overrides(response_headers)
        try:
            settle = await http_server.process_settlement(
                payload,
                requirements,
                context=context,
                settlement_overrides=overrides,
                declared_extensions=result.declared_extensions,
                transport_context=HTTPTransportContext(
                    request=context,
                    response_body=res.body if before is None else None,
                    response_headers=response_headers,
                ),
                before_handler_settlement=before,
            )
        except FacilitatorResponseError as error:
            return _facilitator_error_response(error)
        except Exception:
            logger.exception("radius-sdk: settlement failed")
            return _json_response({"error": "settlement_error"}, 402)
        if slot.error is not None:
            return _facilitator_error_response(slot.error)
        if not settle.success:
            return _instructions_to_response(settle.response)
        _set_headers(res, settle.headers)
        res.headers["cache-control"] = with_private_cache_control(res.headers.get("cache-control"))
        if SETTLEMENT_OVERRIDES_HEADER in res.headers:
            del res.headers[SETTLEMENT_OVERRIDES_HEADER]
        return res

    async def _handle_mpp(
        self, request: Request, context: HTTPRequestContext, x402_challenge: Response, next: NextHandler
    ) -> Response:
        """Pay with an MPP credential: verify against the route's x402 offers, settle per ``settle``, attach ``Payment-Receipt``."""
        m = self.radius.mpp
        assert m is not None

        def failed(f: MppFailure) -> Response:
            if f.status == 502:
                return _json_response({"error": "facilitator_error", "message": f.reason}, 502)
            return m.rejection(request, x402_challenge, f.reason)

        verified = await m.verify(request, x402_challenge)
        if not isinstance(verified, MppVerified):
            return failed(verified)

        def with_receipt(res: Response, receipt: PaymentReceipt) -> Response:
            res.headers[MPP_RECEIPT_HEADER] = m.receipt_header(receipt)
            res.headers["cache-control"] = with_private_cache_control(res.headers.get("cache-control"))
            return res

        if self.radius.settle_mode == "before":
            settled = await m.settle(verified)
            if isinstance(settled, MppFailure):
                return failed(settled)
            await self.radius.notify_settled(settled.receipt, context)
            try:
                res = await _call_next(next, request, settled.receipt)
            except Exception as error:
                # Paid but undelivered: the receipt goes back with the error so the buyer can reconcile.
                return with_receipt(_internal_error_response(error), settled.receipt)
            return with_receipt(res, settled.receipt)

        res = await _call_next(next, request, None)
        if res.status_code >= 400:
            return res
        settled = await m.settle(verified)
        if isinstance(settled, MppFailure):
            return failed(settled)
        await self.radius.notify_settled(settled.receipt, context)
        return with_receipt(res, settled.receipt)


def create_payment_handler(radius: RadiusServer, routes: dict[str, RouteConfig]) -> PaymentHandler:
    """Starlette handler for an already-built x402 routes config (see :meth:`RadiusServer.build_routes`)."""
    return PaymentHandler(radius, routes)


__all__ = [
    "EIP2612_GAS_SPONSORING",
    "GAS_SPONSORING_DECLARATION",
    "MPP_RECEIPT_HEADER",
    "FacilitatorClient",
    "FacilitatorOptions",
    "GasSponsoringMode",
    "MppPayments",
    "MppServerOptions",
    "NextHandler",
    "PayTo",
    "PaymentHandler",
    "RadiusExactScheme",
    "RadiusFacilitatorClient",
    "RadiusServer",
    "RequestAdapter",
    "RouteSpec",
    "RouteSpecs",
    "ServerNetwork",
    "SettleMode",
    "create_payment_handler",
    "create_radius_server",
    "proxy_to",
    "radius_payments",
    "read_body",
    "request_context",
    "request_of",
    "static_supported",
    "to_receipt",
    "with_unknown_outcomes",
]
