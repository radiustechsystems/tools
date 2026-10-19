"""Facilitator clients: the hosted x402 facilitator over HTTP, and the wrapper that turns unknown outcomes into 502s."""

from __future__ import annotations

import asyncio
import contextvars
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

import httpx
from x402.http.facilitator_client_base import FacilitatorResponseError
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    SettleError,
    SettleResponse,
    SupportedResponse,
    VerifyError,
    VerifyResponse,
)

from ..networks import PaymentNetwork

DEFAULT_TIMEOUT_SECONDS = 30.0
_SUPPORTED_RETRIES = 3


@runtime_checkable
class FacilitatorClient(Protocol):
    """What the resource server needs from a facilitator (x402's async ``FacilitatorClient``).

    ``get_supported`` is synchronous, as in the x402 Python core; the SDK calls it off the event loop.
    """

    async def verify(self, payload: PaymentPayload, requirements: PaymentRequirements) -> VerifyResponse: ...

    async def settle(self, payload: PaymentPayload, requirements: PaymentRequirements) -> SettleResponse: ...

    def get_supported(self) -> SupportedResponse: ...


@dataclass(frozen=True)
class FacilitatorOptions:
    """How to reach a hosted facilitator."""

    #: Facilitator base URL. Defaults to the network's (Radius's own; x402.org on Base Sepolia); required on Base.
    url: str | None = None
    #: Sent as ``x-api-key`` on verify/settle/supported.
    api_key: str | None = None
    #: Default true: ``/supported`` is fetched from the facilitator on the first paid request after each
    #: start, so facilitator changes propagate without an SDK update. False uses the built-in answer
    #: for Radius (no network call before the first 402; goes stale if the facilitator changes).
    live: bool = True
    timeout: float = DEFAULT_TIMEOUT_SECONDS
    #: ``httpx.AsyncClient`` for verify/settle (``/supported`` uses a sync client of its own).
    http_client: Any = None

    @classmethod
    def coerce(cls, value: FacilitatorOptions | Mapping[str, Any] | None) -> FacilitatorOptions:
        if value is None:
            return cls()
        if isinstance(value, FacilitatorOptions):
            return value
        names = {"url", "api_key", "apiKey", "live", "timeout", "http_client"}
        unknown = set(value) - names
        if unknown:
            raise ValueError(f"radius-sdk: unknown facilitator options {sorted(unknown)}")
        return cls(
            url=value.get("url"),
            api_key=value.get("api_key", value.get("apiKey")),
            live=value.get("live", True),
            timeout=value.get("timeout", DEFAULT_TIMEOUT_SECONDS),
            http_client=value.get("http_client"),
        )


def static_supported(network: PaymentNetwork) -> SupportedResponse:
    """The ``/supported`` answer the Radius facilitators return for a Radius network.

    ``exact`` in SBC by EIP-3009 (listed first, so offers use it) or Permit2, and sponsored EIP-2612 approvals.
    """
    if not network.radius:
        raise ValueError(
            f"static_supported: {network.name} is not a Radius network; its facilitator's /supported must be fetched"
        )
    return SupportedResponse.model_validate(
        {
            "kinds": [
                {
                    "x402Version": 2,
                    "scheme": "exact",
                    "network": network.network,
                    "extra": {
                        "assetTransferMethod": method,
                        "name": network.asset.name,
                        "version": network.asset.version,
                    },
                }
                for method in ("eip3009", "permit2")
            ],
            "extensions": ["eip2612GasSponsoring"],
            "signers": {},
        }
    )


def _excerpt(text: str, limit: int = 200) -> str:
    compact = " ".join(text.split())
    if not compact:
        return "<empty response>"
    return compact if len(compact) <= limit else compact[: limit - 3] + "..."


def _body(payload: PaymentPayload, requirements: PaymentRequirements) -> dict[str, Any]:
    return {
        "x402Version": payload.x402_version,
        "paymentPayload": payload.model_dump(by_alias=True, exclude_none=True),
        "paymentRequirements": requirements.model_dump(by_alias=True, exclude_none=True),
    }


class RadiusFacilitatorClient:
    """Client for a hosted x402 facilitator (the network's default: Radius's on Radius, x402.org on Base Sepolia).

    Nothing runs at construction. Error handling follows ``@x402/core``'s HTTP facilitator client: a
    non-2xx answer whose body is the facilitator's own verify/settle response raises
    ``VerifyError`` / ``SettleError`` (a rejection, answered 402); anything else raises a plain error,
    which :func:`with_unknown_outcomes` turns into a 502.
    """

    def __init__(
        self,
        network: PaymentNetwork,
        options: FacilitatorOptions | Mapping[str, Any] | None = None,
        *,
        http_client: httpx.AsyncClient | None = None,
        sync_http_client: httpx.Client | None = None,
    ) -> None:
        opts = FacilitatorOptions.coerce(options)
        url = opts.url or network.facilitator_url
        if not url:
            raise ValueError(
                f"radius-sdk: no default facilitator for {network.name}; pass facilitator={{'url': ...}} (or a FacilitatorClient) for it"
            )
        if not opts.live and not network.radius:
            raise ValueError(
                f"radius-sdk: facilitator live=False is only available on Radius networks (got {network.name})"
            )
        self.url = url.rstrip("/")
        self.network = network
        self.live = opts.live
        self.timeout = opts.timeout
        self._headers = {"Content-Type": "application/json", **({"x-api-key": opts.api_key} if opts.api_key else {})}
        self._http = http_client or opts.http_client
        self._sync_http = sync_http_client

    def _async(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=self.timeout, follow_redirects=True)
        return self._http

    def _sync(self) -> httpx.Client:
        if self._sync_http is None:
            self._sync_http = httpx.Client(timeout=self.timeout, follow_redirects=True)
        return self._sync_http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
        if self._sync_http is not None:
            self._sync_http.close()

    async def verify(self, payload: PaymentPayload, requirements: PaymentRequirements) -> VerifyResponse:
        res = await self._async().post(
            f"{self.url}/verify", headers=self._headers, content=json.dumps(_body(payload, requirements))
        )
        if not res.is_success:
            data = _json_or_raise(res, "verify")
            if isinstance(data, dict) and "isValid" in data:
                parsed = VerifyResponse.model_validate(data)
                raise VerifyError(parsed.invalid_reason or "invalid_payment", parsed.invalid_message, parsed.payer)
            raise RuntimeError(f"Facilitator verify failed ({res.status_code}): {_excerpt(json.dumps(data))}")
        return _parse(res, VerifyResponse, "verify")

    async def settle(self, payload: PaymentPayload, requirements: PaymentRequirements) -> SettleResponse:
        res = await self._async().post(
            f"{self.url}/settle", headers=self._headers, content=json.dumps(_body(payload, requirements))
        )
        if not res.is_success:
            data = _json_or_raise(res, "settle")
            if isinstance(data, dict) and "success" in data:
                parsed = SettleResponse.model_validate({"transaction": "", "network": requirements.network, **data})
                raise SettleError(
                    parsed.error_reason or "settle_failed",
                    parsed.error_message,
                    parsed.transaction or None,
                    parsed.payer,
                )
            raise RuntimeError(f"Facilitator settle failed ({res.status_code}): {_excerpt(json.dumps(data))}")
        return _parse(res, SettleResponse, "settle")

    def get_supported(self) -> SupportedResponse:
        if not self.live:
            return static_supported(self.network)
        last: Exception | None = None
        for attempt in range(_SUPPORTED_RETRIES):
            res = self._sync().get(f"{self.url}/supported", headers=self._headers)
            if res.is_success:
                return _parse(res, SupportedResponse, "supported")
            last = RuntimeError(f"Facilitator getSupported failed ({res.status_code}): {_excerpt(res.text)}")
            if res.status_code == 429 and attempt < _SUPPORTED_RETRIES - 1:
                retry_after = res.headers.get("retry-after")
                delay = float(retry_after) if retry_after and retry_after.isdigit() else 0.5 * 2**attempt
                time.sleep(min(delay, 10.0))
                continue
            raise last
        raise last or RuntimeError("Facilitator getSupported failed after retries")


def _json_or_raise(res: httpx.Response, operation: str) -> Any:
    try:
        return res.json()
    except ValueError:
        raise RuntimeError(f"Facilitator {operation} failed ({res.status_code}): {_excerpt(res.text)}") from None


def _parse(res: httpx.Response, model: Any, operation: str) -> Any:
    try:
        data = res.json()
    except ValueError as e:
        raise FacilitatorResponseError(f"Facilitator {operation} returned invalid JSON: {_excerpt(res.text)}") from e
    try:
        return model.model_validate(data)
    except Exception as e:
        raise FacilitatorResponseError(f"Facilitator {operation} returned invalid data: {_excerpt(res.text)}") from e


class UnknownOutcome:
    """Per-request slot recording a facilitator call that failed without the facilitator's own answer."""

    def __init__(self) -> None:
        self.error: FacilitatorResponseError | None = None


#: The current request's slot (set by the payment handler for each paid request).
current_unknown_outcome: contextvars.ContextVar[UnknownOutcome | None] = contextvars.ContextVar(
    "radius_sdk_unknown_outcome", default=None
)


class _UnknownOutcomes:
    def __init__(self, facilitator: Any) -> None:
        self.inner = facilitator

    async def _call(self, operation: str, fn: Any) -> Any:
        try:
            return await fn()
        except (VerifyError, SettleError):
            raise  # the facilitator's own answer
        except Exception as error:
            fe = (
                error
                if isinstance(error, FacilitatorResponseError)
                else FacilitatorResponseError(f"Facilitator {operation} failed: {error}")
            )
            if fe is not error:
                fe.__cause__ = error
            slot = current_unknown_outcome.get()
            if slot is not None:
                slot.error = fe
            raise fe from (None if fe is error else error)

    async def verify(self, payload: PaymentPayload, requirements: PaymentRequirements) -> VerifyResponse:
        return await self._call("verify", lambda: self.inner.verify(payload, requirements))

    async def settle(self, payload: PaymentPayload, requirements: PaymentRequirements) -> SettleResponse:
        return await self._call("settle", lambda: self.inner.settle(payload, requirements))

    def get_supported(self) -> SupportedResponse:
        try:
            return self.inner.get_supported()
        except FacilitatorResponseError:
            raise
        except Exception as error:
            raise FacilitatorResponseError(f"Facilitator supported failed: {error}") from error


def with_unknown_outcomes(facilitator: Any) -> Any:
    """Wrap a facilitator so calls that fail without its own answer surface as a 502, not a 402.

    A network error, or an error status whose body is not an x402 response, leaves the outcome unknown:
    a settle may have reached the chain. The x402 core reports those as a 402, which a buyer reads as
    "rejected, nothing moved", so this re-raises them as ``FacilitatorResponseError`` and records them
    for the current request, which the payment handler answers with 502. The facilitator's own answers
    (``VerifyError``, ``SettleError``) pass through.
    """
    return _UnknownOutcomes(facilitator)


async def get_supported_async(facilitator: Any) -> SupportedResponse:
    """``facilitator.get_supported()`` off the event loop."""
    return await asyncio.to_thread(facilitator.get_supported)
