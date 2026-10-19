"""MPP (the HTTP ``Payment`` auth scheme, ``evm`` charge method) alongside x402, for sellers."""

from __future__ import annotations

import hmac
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Protocol

from x402.http.facilitator_client_base import FacilitatorResponseError
from x402.schemas import PaymentPayload, PaymentRequirements

from ..mpp import (
    MPP_INTENT,
    MPP_METHOD,
    MPP_RECEIPT_HEADER,
    MppChallenge,
    MppReceipt,
    encode_request,
    js_json,
    mpp_challenge_id,
    mpp_challenge_nonce,
    mpp_source,
    parse_mpp_credential,
    serialize_mpp_challenge,
    serialize_mpp_receipt,
)
from ..networks import PaymentNetwork, explorer_tx_url
from ..receipt import PaymentReceipt, decode_header_json

if TYPE_CHECKING:
    from starlette.requests import Request
    from starlette.responses import Response

PROBLEM_TYPE = "https://paymentauth.org/problems/verification-failed"


@dataclass(frozen=True)
class MppServerOptions:
    """MPP for sellers."""

    #: Key for the HMAC that binds challenge ids to their parameters, so credentials are verified
    #: without storing challenges. At least 32 characters of random data (``openssl rand -base64 32``);
    #: keep it stable across instances that serve the same routes.
    secret_key: str
    #: Realm named in challenges. Default: the request's host.
    realm: str | None = None


class MppHost(Protocol):
    @property
    def networks(self) -> Sequence[PaymentNetwork]: ...

    def facilitator_for(self, network: PaymentNetwork) -> Any: ...


@dataclass
class MppVerified:
    network: PaymentNetwork
    requirements: PaymentRequirements
    payload: PaymentPayload
    payer: str
    ok: bool = True


@dataclass
class MppFailure:
    status: int  # 402 or 502
    reason: str
    ok: bool = False


@dataclass
class MppSettled:
    receipt: PaymentReceipt
    ok: bool = True


def _iso(dt: datetime) -> str:
    """``Date.prototype.toISOString``: UTC with milliseconds and a ``Z``."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _parse_iso(value: str) -> float | None:
    try:
        text = value.strip()
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


class MppPayments:
    """MPP challenges mirroring the x402 offers a route resolves to, and credentials settled through the same facilitators.

    Credentials are EIP-3009 authorizations, converted to x402 ``exact`` payloads. No state: the
    challenge id is an HMAC of its parameters.
    """

    def __init__(self, host: MppHost, options: MppServerOptions | dict[str, Any]) -> None:
        opts = options if isinstance(options, MppServerOptions) else MppServerOptions(**options)
        if not isinstance(opts.secret_key, str) or len(opts.secret_key) < 32:
            raise ValueError(
                "radius-sdk: mpp secret_key must be at least 32 characters of random data (e.g. `openssl rand -base64 32`)"
            )
        self.host = host
        self.options = opts
        self._key = opts.secret_key.encode("utf-8")

    def _realm_of(self, request: Request) -> str:
        return self.options.realm or request.url.netloc

    def _network_of(self, chain_id: Any) -> PaymentNetwork | None:
        return next((n for n in self.host.networks if n.chain_id == chain_id and not isinstance(chain_id, bool)), None)

    def _mirrorable(self, x402_challenge: Response) -> tuple[list[tuple[dict[str, Any], PaymentNetwork]], str | None]:
        """x402 offers of a 402 that MPP can mirror: ``exact`` by EIP-3009 on a configured network, in its asset."""
        header = x402_challenge.headers.get("payment-required")
        if not header:
            return [], None
        pr = decode_header_json(header)
        accepts: list[tuple[dict[str, Any], PaymentNetwork]] = []
        for requirements in pr.get("accepts") or []:
            network = next((n for n in self.host.networks if n.network == requirements.get("network")), None)
            if network is None or requirements.get("scheme") != "exact":
                continue
            if str(requirements.get("asset", "")).lower() != network.asset.address.lower():
                continue
            if (requirements.get("extra") or {}).get("assetTransferMethod") != "eip3009":
                continue
            accepts.append((requirements, network))
        resource = pr.get("resource") or {}
        return accepts, (resource.get("description") or None)

    def challenges(self, request: Request, x402_challenge: Response) -> list[str]:
        """The ``WWW-Authenticate`` challenges for a route's x402 402 (one per network)."""
        accepts, description = self._mirrorable(x402_challenge)
        realm = self._realm_of(request)
        out = []
        for requirements, network in accepts:
            body = {
                "amount": requirements["amount"],
                "currency": requirements["asset"],
                "recipient": requirements["payTo"],
                "methodDetails": {
                    "chainId": network.chain_id,
                    "credentialTypes": ["authorization"],
                    "decimals": network.asset.decimals,
                },
            }
            expires = datetime.now(timezone.utc) + timedelta(seconds=int(requirements.get("maxTimeoutSeconds") or 300))
            c = MppChallenge(
                id="",
                realm=realm,
                method=MPP_METHOD,
                intent=MPP_INTENT,
                request=body,
                request_encoded=encode_request(body),
                description=description,
                expires=_iso(expires),
            )
            c.id = mpp_challenge_id(self._key, c)
            out.append(serialize_mpp_challenge(c))
        return out

    def add_challenges(self, request: Request, res: Response) -> Response:
        """Add MPP challenges to an x402 402 (in place)."""
        for c in self.challenges(request, res):
            res.headers.append("WWW-Authenticate", c)
        return res

    async def verify(self, request: Request, x402_challenge: Response) -> MppVerified | MppFailure:
        """Check an ``Authorization: Payment`` credential against the route's current x402 offers.

        HMAC id, realm, expiry, method, the exact amount / asset / recipient / network, the
        authorization's nonce binding and validity window, then the facilitator's ``/verify``.
        """
        try:
            credential = parse_mpp_credential(request.headers.get("authorization"))
        except Exception as e:
            return MppFailure(402, f"malformed credential: {e}")
        if credential is None:
            return MppFailure(402, "no Payment credential")
        c, p, source = credential.challenge, credential.payload, credential.source

        def fail(reason: str) -> MppFailure:
            return MppFailure(402, reason)

        if not hmac.compare_digest(c.id, mpp_challenge_id(self._key, c)):
            return fail("challenge was not issued by this server")
        if c.realm != self._realm_of(request):
            return fail("challenge realm does not match")
        if c.method != MPP_METHOD or c.intent != MPP_INTENT:
            return fail(f"unsupported method {c.method}/{c.intent}")
        expires = _parse_iso(c.expires) if c.expires else None
        if expires is None or expires < time.time():
            return fail("challenge expired")

        r = c.request
        raw_details = r.get("methodDetails")
        details: dict[str, Any] = raw_details if isinstance(raw_details, dict) else {}
        network = self._network_of(details.get("chainId"))
        currency, recipient, amount = r.get("currency"), r.get("recipient"), r.get("amount")
        if (
            network is None
            or not isinstance(currency, str)
            or not isinstance(recipient, str)
            or not isinstance(amount, str)
        ):
            return fail("credential request is not payable here")
        accepts, _ = self._mirrorable(x402_challenge)
        match = next(
            (
                req
                for req, n in accepts
                if n is network
                and str(req.get("asset", "")).lower() == currency.lower()
                and str(req.get("payTo", "")).lower() == recipient.lower()
                and req.get("amount") == amount
            ),
            None,
        )
        if match is None:
            return fail("credential does not match this route's price")

        if not isinstance(p, dict) or p.get("type") != "authorization":
            return fail("payload is not an EIP-3009 authorization")
        if str(p.get("to", "")).lower() != recipient.lower():
            return fail("authorization recipient mismatch")
        if p.get("value") != amount:
            return fail("authorization amount mismatch")
        if str(p.get("nonce", "")).lower() != mpp_challenge_nonce(c):
            return fail("authorization is not bound to this challenge")
        now = int(time.time())
        try:
            if _big(p.get("validAfter")) > now:
                return fail("authorization is not valid yet")
            if _big(p.get("validBefore")) <= now:
                return fail("authorization has expired")
        except ValueError:
            return fail("authorization validity window is malformed")
        if source is not None and source.lower() != mpp_source(network.chain_id, str(p.get("from", ""))).lower():
            return fail("credential source does not match the payer")

        # The offer the credential matched, as the route's x402 402 lists it (the facilitator's EIP-712
        # domain and extras included): the facilitator sees the same requirements an x402 payer would.
        requirements = PaymentRequirements.model_validate(match)
        payload = PaymentPayload.model_validate(
            {
                "x402Version": 2,
                "accepted": match,
                "payload": {
                    "authorization": {
                        "from": p.get("from"),
                        "to": p.get("to"),
                        "value": p.get("value"),
                        "validAfter": p.get("validAfter"),
                        "validBefore": p.get("validBefore"),
                        "nonce": p.get("nonce"),
                    },
                    "signature": p.get("signature"),
                },
            }
        )
        try:
            verified = await self.host.facilitator_for(network).verify(payload, requirements)
            if not verified.is_valid:
                return fail(
                    verified.invalid_message or verified.invalid_reason or "facilitator rejected the authorization"
                )
        except Exception as e:
            return _facilitator_failure(e)
        return MppVerified(network=network, requirements=requirements, payload=payload, payer=str(p.get("from")))

    async def settle(self, v: MppVerified) -> MppSettled | MppFailure:
        """Settle a verified credential; the receipt on success."""
        try:
            settled = await self.host.facilitator_for(v.network).settle(v.payload, v.requirements)
            if not settled.success or not settled.transaction:
                return MppFailure(402, settled.error_message or settled.error_reason or "settlement failed")
            return MppSettled(
                PaymentReceipt(
                    success=True,
                    protocol="mpp",
                    transaction=settled.transaction,
                    network=v.network.network,
                    payer=settled.payer or v.payer,
                    amount=v.requirements.amount,
                    explorer_url=explorer_tx_url(v.network, settled.transaction),
                )
            )
        except Exception as e:
            return _facilitator_failure(e)

    def receipt_header(self, receipt: PaymentReceipt) -> str:
        """``Payment-Receipt`` header value for a settled payment."""
        return serialize_mpp_receipt(
            MppReceipt(
                method=MPP_METHOD,
                reference=receipt.transaction or "",
                status="success",
                timestamp=_iso(datetime.now(timezone.utc)),
            )
        )

    def rejection(self, request: Request, x402_challenge: Response, reason: str) -> Response:
        """A 402 that explains a failed credential and offers fresh challenges (and the route's x402 offers)."""
        from starlette.responses import Response as StarletteResponse

        body = js_json({"type": PROBLEM_TYPE, "title": "Payment verification failed", "status": 402, "detail": reason})
        res = StarletteResponse(content=body, status_code=402)
        for k, v in x402_challenge.headers.items():
            if k.lower() not in ("content-length", "content-type"):
                res.headers.append(k, v)
        res.headers["content-type"] = "application/problem+json"
        return self.add_challenges(request, res)


def _big(value: Any) -> int:
    """JavaScript ``BigInt(value)`` for the decimal and 0x-hex strings an authorization carries."""
    text = str(value).strip()
    if text.lower().startswith("0x"):
        return int(text[2:], 16)
    if not text.isdigit():
        raise ValueError(text)
    return int(text)


def _facilitator_failure(e: Exception) -> MppFailure:
    if isinstance(e, FacilitatorResponseError):
        return MppFailure(502, str(e))
    # The facilitator answered with its own rejection (VerifyError / SettleError).
    return MppFailure(402, str(e))


__all__ = ["MPP_RECEIPT_HEADER", "MppPayments", "MppServerOptions", "MppVerified", "MppFailure", "MppSettled"]
