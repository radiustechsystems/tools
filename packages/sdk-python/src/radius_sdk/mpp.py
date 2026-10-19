"""Wire format of MPP (Machine Payments Protocol, the HTTP ``Payment`` authentication scheme,
draft-httpauth-payment) for its ``evm`` / ``charge`` method: an EIP-3009
``transferWithAuthorization`` signed by the payer and settled through an x402 facilitator::

    402 + WWW-Authenticate: Payment id="…", realm="…", method="evm", intent="charge",
          request="<b64url JSON>", expires="<ISO>"        one challenge per network offered
    retry + Authorization: Payment <b64url JSON {challenge, payload, source}>
    200 + Payment-Receipt: <b64url JSON {method, reference, status, timestamp}>

A port of the TypeScript SDK's ``src/mpp.ts``, which is checked against mppx (the reference
implementation) in both directions; ``tests/test_interop.py`` checks this module against the
TypeScript one. Change them together.
"""

from __future__ import annotations

import base64
import dataclasses
import hashlib
import hmac
import json
import math
import re
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

from eth_utils import keccak

MPP_SCHEME = "Payment"
MPP_RECEIPT_HEADER = "payment-receipt"
MPP_METHOD = "evm"
MPP_INTENT = "charge"


@dataclass
class MppChallenge:
    """A ``Payment`` challenge as it appears in ``WWW-Authenticate``."""

    id: str
    realm: str
    method: str
    intent: str
    #: Decoded ``request`` parameter.
    request: dict[str, Any]
    #: ``request`` exactly as the server sent it (base64url JSON).
    request_encoded: str
    description: str | None = None
    digest: str | None = None
    #: ISO 8601.
    expires: str | None = None
    #: Header the credential goes in, when not ``Authorization``.
    header: str | None = None
    #: Server-defined base64url data, echoed untouched.
    opaque: str | None = None


_OPTIONAL_PARAMS = ("description", "digest", "expires", "header", "opaque")


MppAuthorizationPayload = TypedDict(
    "MppAuthorizationPayload",
    {
        "type": Literal["authorization"],
        "from": str,
        "to": str,
        "value": str,
        "validAfter": str,
        "validBefore": str,
        "nonce": str,
        "signature": str,
    },
)


@dataclass
class MppReceipt:
    method: str
    #: Settlement transaction hash.
    reference: str
    status: Literal["success"]
    #: ISO 8601.
    timestamp: str
    external_id: str | None = None


# -- base64url and canonical JSON --------------------------------------------------------------


def base64url_encode(data: str | bytes) -> str:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def base64url_decode(data: str) -> str:
    """Decode base64url (or base64) to text; raises ValueError on characters outside the alphabet."""
    b64 = data.replace("-", "+").replace("_", "/")
    b64 += "=" * ((4 - len(b64) % 4) % 4)
    try:
        raw = base64.b64decode(b64, validate=True)
    except (ValueError, TypeError) as e:
        raise ValueError(f"invalid base64url: {e}") from e
    return raw.decode("utf-8", errors="replace")


def js_json(value: Any) -> str:
    """``JSON.stringify`` of plain JSON data: no whitespace, non-ASCII kept, numbers as JavaScript prints them."""
    if value is None or isinstance(value, (bool, str)):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _js_number(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(js_json(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(f"{json.dumps(str(k), ensure_ascii=False)}:{js_json(v)}" for k, v in value.items()) + "}"
    raise TypeError(f"js_json: cannot serialize {type(value).__name__}")


def _js_number(f: float) -> str:
    """ECMAScript Number::toString for a float (shortest round-trip digits, JS exponent rules)."""
    if math.isnan(f) or math.isinf(f):
        return "null"
    if f == 0:
        return "0"
    sign = "-" if f < 0 else ""
    digits, _, exp = repr(abs(f)).lower().partition("e")
    int_part, _, frac_part = digits.partition(".")
    if frac_part == "0":
        frac_part = ""
    all_digits = (int_part + frac_part).lstrip("0")
    # n: position of the decimal point relative to the first significant digit (ES spec)
    lead_zeros = len(int_part + frac_part) - len((int_part + frac_part).lstrip("0"))
    n = len(int_part) - lead_zeros + (int(exp) if exp else 0)
    all_digits = all_digits.rstrip("0") or "0"
    k = len(all_digits)
    if k <= n <= 21:
        return sign + all_digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + all_digits[:n] + "." + all_digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + all_digits
    e = n - 1
    exp_text = f"e{'+' if e >= 0 else '-'}{abs(e)}"
    if k == 1:
        return sign + all_digits + exp_text
    return sign + all_digits[0] + "." + all_digits[1:] + exp_text


def canonical_json(value: Any) -> str:
    """RFC 8785-style canonical JSON: object keys sorted (by UTF-16 code units), no whitespace."""
    if value is None or not isinstance(value, (dict, list, tuple)):
        return js_json(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    entries = sorted(((str(k), v) for k, v in value.items()), key=lambda kv: kv[0].encode("utf-16-be"))
    return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{canonical_json(v)}" for k, v in entries) + "}"


def encode_request(request: dict[str, Any]) -> str:
    """The ``request`` parameter: base64url of the canonical JSON."""
    return base64url_encode(canonical_json(request))


# -- WWW-Authenticate -------------------------------------------------------------------------

MAX_REQUEST_LENGTH = 16 * 1024


def parse_mpp_challenges(header: str | None) -> list[MppChallenge]:
    """Every ``Payment`` challenge in a ``WWW-Authenticate`` value (several may share one header). Malformed ones are skipped."""
    if not header:
        return []
    starts = _scheme_starts(header, MPP_SCHEME)
    out: list[MppChallenge] = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(header)
        try:
            out.append(_parse_challenge(re.sub(r",\s*$", "", header[start + len(MPP_SCHEME) : end])))
        except Exception:
            continue  # not a usable Payment challenge
    return out


def _parse_challenge(params: str) -> MppChallenge:
    p = _parse_auth_params(params)
    id, realm, method, intent, request = (p.get(k) for k in ("id", "realm", "method", "intent", "request"))
    if not id or realm is None or not method or not intent or not request:
        raise ValueError("incomplete Payment challenge")
    if len(request) > MAX_REQUEST_LENGTH:
        raise ValueError("request parameter too large")
    decoded = json.loads(base64url_decode(request))
    if not isinstance(decoded, dict):
        raise ValueError("request is not an object")
    return MppChallenge(
        id=id,
        realm=realm,
        method=method,
        intent=intent,
        request=decoded,
        request_encoded=request,
        **{k: p[k] for k in _OPTIONAL_PARAMS if k in p},
    )


def _is_space(c: str) -> bool:
    return c.isspace()


def _scheme_starts(value: str, token: str) -> list[int]:
    """Offsets where ``token`` starts an auth scheme (outside quoted strings, at the start or after a comma)."""
    starts: list[int] = []
    in_quotes = False
    escaped = False
    lower_token = token.lower()
    for i, c in enumerate(value):
        if in_quotes:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_quotes = False
            continue
        if c == '"':
            in_quotes = True
            continue
        after = value[i + len(token)] if i + len(token) < len(value) else ""
        if value[i : i + len(token)].lower() != lower_token or not after or not _is_space(after):
            continue
        j = i - 1
        while j >= 0 and _is_space(value[j]):
            j -= 1
        if j < 0 or value[j] == ",":
            starts.append(i)
    return starts


_KEY_CHAR = re.compile(r"[A-Za-z0-9_-]")


def _parse_auth_params(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    i = 0
    n = len(text)
    while i < n:
        while i < n and (text[i] == "," or _is_space(text[i])):
            i += 1
        if i >= n:
            break
        key_start = i
        while i < n and _KEY_CHAR.match(text[i]):
            i += 1
        key = text[key_start:i].lower()
        if not key:
            raise ValueError("malformed auth-param")
        while i < n and _is_space(text[i]):
            i += 1
        if i >= n or text[i] != "=":
            break  # the next auth scheme
        i += 1
        while i < n and _is_space(text[i]):
            i += 1
        if i < n and text[i] == '"':
            value, i = _read_quoted(text, i + 1)
        else:
            start = i
            while i < n and text[i] != ",":
                i += 1
            value = text[start:i].strip()
        if key in result:
            raise ValueError(f"duplicate parameter {key}")
        result[key] = value
    return result


_HEX4 = re.compile(r"^[0-9A-Fa-f]{4}$")


def _read_quoted(text: str, start: int) -> tuple[str, int]:
    units: list[str] = []  # UTF-16 code units may arrive as \uXXXX surrogate pairs
    i = start
    n = len(text)
    while i < n:
        c = text[i]
        if c == '"':
            return _join_units(units), i + 1
        if c != "\\":
            units.append(c)
            i += 1
            continue
        i += 1
        nxt = text[i] if i < n else ""
        hex4 = text[i + 1 : i + 5]
        if nxt == "u" and _HEX4.match(hex4):
            units.append(chr(int(hex4, 16)))
            i += 5
        else:
            units.append(nxt)
            i += 1
    raise ValueError("unterminated quoted-string")


def _join_units(units: list[str]) -> str:
    s = "".join(units)
    try:
        return s.encode("utf-16", "surrogatepass").decode("utf-16")
    except UnicodeDecodeError:
        return s


def _auth_param(name: str, value: str) -> str:
    if "\r" in value or "\n" in value:
        raise ValueError(f"invalid {name}: line breaks are not allowed")
    out: list[str] = []
    for ch in value.replace("\\", "\\\\").replace('"', '\\"'):
        cp = ord(ch)
        if cp < 0x100:
            out.append(ch)
        elif cp <= 0xFFFF:
            out.append(f"\\u{cp:04x}")
        else:  # JavaScript escapes each UTF-16 code unit of the pair
            cp -= 0x10000
            out.append(f"\\u{0xD800 + (cp >> 10):04x}\\u{0xDC00 + (cp & 0x3FF):04x}")
    return f'{name}="{"".join(out)}"'


def serialize_mpp_challenge(c: MppChallenge) -> str:
    """One ``WWW-Authenticate`` challenge."""
    parts = [
        _auth_param("id", c.id),
        _auth_param("realm", c.realm),
        _auth_param("method", c.method),
        _auth_param("intent", c.intent),
        _auth_param("request", c.request_encoded),
    ]
    for k in _OPTIONAL_PARAMS:
        v = getattr(c, k)
        if v is not None:
            parts.append(_auth_param(k, v))
    return f"{MPP_SCHEME} {', '.join(parts)}"


# -- challenge id, nonce -----------------------------------------------------------------------


def mpp_challenge_id(secret: str | bytes, c: MppChallenge) -> str:
    """The challenge id: HMAC-SHA256 (base64url) over ``realm|method|intent|request|expires|digest|opaque``.

    A non-default credential header is bound before ``opaque``. Stateless: the server recomputes it
    from the echoed challenge to prove it issued those exact parameters. ``c.id`` is ignored.
    """
    slots = [c.realm, c.method, c.intent, encode_request(c.request), c.expires or "", c.digest or ""]
    if c.header is not None and c.header.lower() != "authorization":
        slots.append(c.header)
    slots.append(c.opaque or "")
    key = secret.encode("utf-8") if isinstance(secret, str) else secret
    return base64url_encode(hmac.new(key, "|".join(slots).encode("utf-8"), hashlib.sha256).digest())


def mpp_challenge_nonce(c: MppChallenge | dict[str, str]) -> str:
    """EIP-3009 nonce binding an authorization to its challenge: keccak256(JSON.stringify([id, realm]))."""
    id, realm = (c["id"], c["realm"]) if isinstance(c, dict) else (c.id, c.realm)
    return "0x" + keccak(text=js_json([id, realm])).hex()


# -- credential and receipt --------------------------------------------------------------------


def _challenge_wire(c: MppChallenge) -> dict[str, Any]:
    wire: dict[str, Any] = {"id": c.id, "realm": c.realm, "method": c.method, "intent": c.intent}
    for k in _OPTIONAL_PARAMS:
        v = getattr(c, k)
        if v is not None:
            wire[k] = v
    wire["request"] = c.request_encoded
    return wire


def serialize_mpp_credential(challenge: MppChallenge, payload: dict[str, Any], source: str | None = None) -> str:
    """``Authorization`` value for a credential answering ``challenge`` (echoed as received)."""
    wire: dict[str, Any] = {"challenge": _challenge_wire(challenge), "payload": payload}
    if source:
        wire["source"] = source
    return f"{MPP_SCHEME} {base64url_encode(js_json(wire))}"


@dataclass
class MppCredential:
    challenge: MppChallenge
    payload: dict[str, Any]
    source: str | None = None


_CREDENTIAL = re.compile(r"^Payment\s+(\S+)\s*$", re.IGNORECASE)


def parse_mpp_credential(header: str | None) -> MppCredential | None:
    """The credential in an ``Authorization: Payment …`` value, or None when there is none. Raises when it is malformed."""
    m = _CREDENTIAL.match(header) if header else None
    if not m:
        return None
    wire = json.loads(base64url_decode(m.group(1)))
    c = wire.get("challenge") if isinstance(wire, dict) else None
    if not isinstance(c, dict) or not isinstance(c.get("request"), str):
        raise ValueError("credential has no challenge")

    def s(k: str) -> str | None:
        v = c.get(k)
        return v if isinstance(v, str) else None

    id, realm, method, intent = s("id"), s("realm"), s("method"), s("intent")
    if not id or realm is None or not method or not intent:
        raise ValueError("credential challenge is incomplete")
    request = json.loads(base64url_decode(c["request"]))
    if not isinstance(request, dict):
        raise ValueError("credential request is not an object")
    challenge = MppChallenge(
        id=id,
        realm=realm,
        method=method,
        intent=intent,
        request=request,
        request_encoded=c["request"],
        **{k: s(k) for k in _OPTIONAL_PARAMS if s(k) is not None},
    )
    payload = wire.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("credential has no payload")
    source = wire.get("source")
    return MppCredential(challenge=challenge, payload=payload, source=source if isinstance(source, str) else None)


def serialize_mpp_receipt(r: MppReceipt) -> str:
    wire: dict[str, Any] = {"method": r.method, "reference": r.reference, "status": r.status, "timestamp": r.timestamp}
    if r.external_id is not None:
        wire["externalId"] = r.external_id
    return base64url_encode(js_json(wire))


def parse_mpp_receipt(header: str) -> MppReceipt:
    r = json.loads(base64url_decode(header))
    if (
        not isinstance(r, dict)
        or not isinstance(r.get("method"), str)
        or not isinstance(r.get("reference"), str)
        or r.get("status") != "success"
    ):
        raise ValueError("malformed Payment-Receipt")
    return MppReceipt(
        method=r["method"],
        reference=r["reference"],
        status="success",
        timestamp=r["timestamp"] if isinstance(r.get("timestamp"), str) else "",
        external_id=r.get("externalId") if isinstance(r.get("externalId"), str) else None,
    )


def mpp_source(chain_id: int, address: str) -> str:
    """``did:pkh`` source identifier of a payer."""
    return f"did:pkh:eip155:{chain_id}:{address}"


def challenge_fields(c: MppChallenge, **changes: Any) -> MppChallenge:
    """A copy of ``c`` with fields replaced (``dataclasses.replace``)."""
    return dataclasses.replace(c, **changes)
