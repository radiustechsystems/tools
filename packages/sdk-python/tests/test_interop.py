"""Cross-language compliance: the Python port against the built TypeScript SDK (``packages/sdk/dist``).

- Golden vectors: the same inputs through both implementations give the same outputs.
- Python buyer → TypeScript seller: every payment must pass ``@x402/core``'s own matching and a facilitator
  that recovers each signature with viem.
- TypeScript buyer → Python seller: ``createRadiusFetch`` pays the Python handler, whose facilitator
  recovers signatures with eth-account.
- The two sellers answer the same 402 for the same configuration.

Needs Node and a built SDK (``pnpm build`` at the repository root); skipped otherwise.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx
import pytest

from helpers import PAY_TO, PK, SIGNER, MockFacilitator, asgi_client, from_b64, recover_eip3009
from radius_sdk import (
    NETWORK_NAMES,
    SBC,
    decode_payment_receipt,
    describe_supported_schemes,
    format_amount,
    get_payment_receipt,
    radius_env,
    radius_testnet,
    resolve_network,
    to_atomic,
)
from radius_sdk.balances import native_balance_bytecode
from radius_sdk.client import create_radius_fetch
from radius_sdk.eip712 import encode_typed_data_type
from radius_sdk.mpp import (
    MppChallenge,
    MppReceipt,
    canonical_json,
    encode_request,
    mpp_challenge_id,
    mpp_challenge_nonce,
    parse_mpp_challenges,
    serialize_mpp_challenge,
    serialize_mpp_credential,
    serialize_mpp_receipt,
)
from radius_sdk.permit2 import Permit2Witness, permit2_witness_hash, permit2_witness_type_string
from radius_sdk.receipt import encode_header_json
from radius_sdk.server import radius_payments

HERE = Path(__file__).parent / "interop"
SDK_DIST = Path(__file__).resolve().parents[2] / "sdk" / "dist" / "index.js"
NODE = shutil.which("node")

_MISSING = NODE is None or not SDK_DIST.exists()
if _MISSING and os.environ.get("RADIUS_REQUIRE_INTEROP"):
    # CI sets this, so a missing Node or SDK build fails the run instead of skipping the comparison.
    raise RuntimeError(f"interop tests need Node and {SDK_DIST} (run `pnpm build` at the repository root)")

pytestmark = [
    pytest.mark.interop,
    pytest.mark.skipif(_MISSING, reason="needs Node and the built TypeScript SDK (pnpm build)"),
]

SECRET = "interop-secret-key-0123456789abcdef"


# -- golden vectors -------------------------------------------------------------------------------

CHALLENGES = [
    {
        "realm": "shop.test",
        "method": "evm",
        "intent": "charge",
        "request": {
            "amount": "1000",
            "currency": SBC.address,
            "recipient": PAY_TO,
            "methodDetails": {"chainId": 72344, "credentialTypes": ["authorization"], "decimals": 6},
        },
        "expires": "2030-01-01T00:00:00.000Z",
        "description": 'One "lookup" — ✓ 𝄞 \\ done',
    },
    {
        "realm": "api.example.com:8443",
        "method": "evm",
        "intent": "charge",
        "request": {"z": [1, 2.5, None, True], "a": {"y": "é", "b": 0.1}},
        "opaque": "b3BhcXVl",
        "header": "X-Pay",
        "digest": "sha-256=:abc:",
    },
    {"realm": "", "method": "evm", "intent": "charge", "request": {}, "header": "Authorization"},
]
WITNESSES = [
    {
        "typeName": "Witness",
        "types": {"Witness": [{"name": "to", "type": "address"}, {"name": "validAfter", "type": "uint256"}]},
        "value": {"to": PAY_TO, "validAfter": 0},
    },
    {
        "typeName": "Witness",
        "types": {
            "Witness": [
                {"name": "to", "type": "address"},
                {"name": "facilitator", "type": "address"},
                {"name": "validAfter", "type": "uint256"},
            ]
        },
        "value": {"to": PAY_TO, "facilitator": "0x00000000000000000000000000000000fac11107", "validAfter": 1234},
    },
    {
        "typeName": "Order",
        "types": {
            "Order": [
                {"name": "item", "type": "Item"},
                {"name": "tags", "type": "string[]"},
                {"name": "memo", "type": "bytes"},
                {"name": "ref", "type": "bytes32"},
            ],
            "Item": [{"name": "sku", "type": "string"}, {"name": "qty", "type": "uint32"}],
        },
        "value": {"item": {"sku": "A-1", "qty": 3}, "tags": ["x", "y"], "memo": "0xdeadbeef", "ref": "0x" + "11" * 32},
    },
]
CASES: dict[str, Any] = {
    "secret": SECRET,
    "toAtomic": [
        ["$0.01", 6],
        ["0.001", 6],
        ["1", 6],
        ["0.05 SBC", 6],
        ["USD 0.5", 6],
        [0.1, 6],
        [1, 18],
        ["0.0000001", 6],
        ["-1", 6],
        ["abc", 6],
        ["1.", 6],
        [" 2.50 usd ", 6],
    ],
    "formatAmount": [
        ["10000", 6, None],
        ["1000000", 6, "SBC"],
        ["0", 6, None],
        ["1", 6, None],
        ["-1500", 3, None],
        ["123456789", 0, "X"],
    ],
    "canonicalJson": [
        {"b": 1, "a": [True, None, {"d": "x", "c": 2.5}]},
        {"é": "ü", "a": "\n\t "},
        [1, "two", 3.25],
        "plain",
        1e21,
        1e-7,
        {"n": 0.000001},
    ],
    "challenges": CHALLENGES,
    "headers": [
        serialize_mpp_challenge(
            MppChallenge(
                id="abc",
                realm="r",
                method="evm",
                intent="charge",
                request={"amount": "1"},
                request_encoded=encode_request({"amount": "1"}),
                description="x, y",
            )
        ),
        'Bearer realm="api", Payment id="a", realm="r", method="evm", intent="charge", request="e30", expires="2030-01-01T00:00:00Z", Payment id="b", realm="r2", method="tempo", intent="charge", request="e30"',
        'Payment id="u", realm="\\u00e9\\ud834\\udd1e", method="evm", intent="charge", request="e30"',
        'Payment id="dup", id="dup2", realm="r", method="evm", intent="charge", request="e30"',
    ],
    "payload": {
        "type": "authorization",
        "from": SIGNER.address,
        "to": PAY_TO,
        "value": "1000",
        "validAfter": "0",
        "validBefore": "1893456000",
        "nonce": "0x" + "00" * 32,
        "signature": "0x01",
    },
    "witnesses": WITNESSES,
    "encodeType": [
        [
            "Mail",
            {
                "Mail": [
                    {"name": "from", "type": "Person"},
                    {"name": "to", "type": "Person[]"},
                    {"name": "note", "type": "Note"},
                ],
                "Person": [{"name": "name", "type": "string"}],
                "Note": [{"name": "body", "type": "string"}],
            },
        ]
    ],
    "addresses": [PAY_TO, SIGNER.address],
    "receipts": [
        encode_header_json(
            {"success": True, "transaction": "0xabc", "network": "eip155:72344", "payer": SIGNER.address}
        ),
        encode_header_json(
            {"success": False, "transaction": "", "network": "eip155:72344", "errorReason": "insufficient_funds"}
        ),
        encode_header_json({"success": True, "transaction": "0xabc", "network": "eip155:72344", "amount": "60"}),
        encode_header_json({"success": True, "transaction": "0xabc", "network": "eip155:72344", "amount": "1.5"}),
    ],
    "env": [
        {},
        {
            "RADIUS_NETWORK": "testnet",
            "RADIUS_PRIVATE_KEY": "0x" + "11" * 32,
            "RADIUS_MAX_PER_REQUEST": "$0.05",
            "RADIUS_SBC_ADDRESS": SBC.address,
        },
        {"RADIUS_NETWORK": "devnet"},
    ],
}


@pytest.fixture(scope="module")
def vectors() -> dict[str, Any]:
    out = subprocess.run(
        [NODE, str(HERE / "ts_vectors.mjs")], input=json.dumps(CASES), capture_output=True, text=True, check=True
    )  # type: ignore[list-item]
    return json.loads(out.stdout)


def _challenge(c: dict[str, Any]) -> MppChallenge:
    return MppChallenge(id="", request_encoded=encode_request(c["request"]), **c)


def _attempt(fn: Any) -> dict[str, Any]:
    try:
        return {"ok": fn()}
    except Exception as e:
        return {"error": str(e)}


class TestGoldenVectors:
    def test_amounts(self, vectors: dict[str, Any]) -> None:
        ours = [_attempt(lambda p=p, d=d: to_atomic(p, d)) for p, d in CASES["toAtomic"]]
        assert [("ok" in o, o.get("ok")) for o in ours] == [("ok" in t, t.get("ok")) for t in vectors["toAtomic"]]
        assert [format_amount(a, d, s) for a, d, s in CASES["formatAmount"]] == vectors["formatAmount"]

    def test_canonical_json_and_request_encoding(self, vectors: dict[str, Any]) -> None:
        assert [canonical_json(v) for v in CASES["canonicalJson"]] == vectors["canonicalJson"]
        objects = [v for v in CASES["canonicalJson"] if isinstance(v, dict)]
        assert [encode_request(v) for v in objects] == vectors["encodeRequest"]

    def test_mpp_challenge_ids_nonces_and_headers(self, vectors: dict[str, Any]) -> None:
        challenges = [_challenge(c) for c in CHALLENGES]
        assert [mpp_challenge_id(SECRET, c) for c in challenges] == vectors["challengeId"]
        assert [mpp_challenge_nonce({"id": f"n{i}", "realm": c["realm"]}) for i, c in enumerate(CHALLENGES)] == vectors[
            "challengeNonce"
        ]
        for c in challenges:
            c.id = mpp_challenge_id(SECRET, c)
        assert [serialize_mpp_challenge(c) for c in challenges] == vectors["serializeChallenge"]
        for c in challenges:
            c.id = "fixed"
        source = "did:pkh:eip155:72344:" + SIGNER.address
        assert [serialize_mpp_credential(c, CASES["payload"], source) for c in challenges] == vectors["credential"]
        assert (
            serialize_mpp_receipt(MppReceipt("evm", "0xabc", "success", "2030-01-01T00:00:00.000Z"))
            == vectors["receipt"]
        )

    def test_mpp_header_parsing(self, vectors: dict[str, Any]) -> None:
        names = {"request_encoded": "requestEncoded"}
        for header, expected in zip(CASES["headers"], vectors["parseChallenges"], strict=True):
            ours = [
                {names.get(k, k): v for k, v in c.__dict__.items() if v is not None}
                for c in parse_mpp_challenges(header)
            ]
            assert ours == expected, header

    def test_permit2_witness_type_strings_and_hashes(self, vectors: dict[str, Any]) -> None:
        witnesses = [Permit2Witness(w["typeName"], w["types"], w["value"]) for w in WITNESSES]
        assert [permit2_witness_type_string(w) for w in witnesses] == vectors["witnessTypeString"]
        assert [permit2_witness_hash(w) for w in witnesses] == vectors["witnessHash"]
        assert [encode_typed_data_type(p, t) for p, t in CASES["encodeType"]] == vectors["encodeType"]

    def test_networks_schemes_and_balance_init_code(self, vectors: dict[str, Any]) -> None:
        assert [native_balance_bytecode(a) for a in CASES["addresses"]] == vectors["nativeBalanceBytecode"]
        assert describe_supported_schemes() == vectors["schemes"]
        ours = []
        for n in NETWORK_NAMES:
            r = resolve_network(n)
            ours.append(
                {
                    "id": n,
                    "name": r.name,
                    "chainId": r.chain_id,
                    "network": r.network,
                    "rpcUrl": r.rpc_url,
                    "explorerUrl": r.explorer_url,
                    "facilitatorUrl": r.facilitator_url,
                    "faucetUrl": r.faucet_url,
                    "asset": r.asset.__dict__,
                    "testnet": r.testnet,
                    "radius": r.radius,
                    "v1Names": list(r.v1_names),
                    "native": r.chain.native_currency.__dict__,
                }
            )
        assert ours == vectors["networks"]

    def test_receipts_and_env(self, vectors: dict[str, Any]) -> None:
        ours = [_attempt(lambda h=h: decode_payment_receipt(h, radius_testnet).to_dict()) for h in CASES["receipts"]]
        assert [("ok" in o, o.get("ok")) for o in ours] == [("ok" in t, t.get("ok")) for t in vectors["receipts"]]
        camel = {
            "rpc_url": "rpcUrl",
            "facilitator_url": "facilitatorUrl",
            "pay_to": "payTo",
            "max_per_request": "maxPerRequest",
        }
        ours_env = [_attempt(lambda e=e: {camel.get(k, k): v for k, v in radius_env(e).items()}) for e in CASES["env"]]
        assert [("ok" in o, o.get("ok")) for o in ours_env] == [("ok" in t, t.get("ok")) for t in vectors["env"]]


# -- Python buyer → TypeScript seller --------------------------------------------------------------


class TsSeller:
    def __init__(self, **options: Any) -> None:
        self.proc = subprocess.Popen(
            [NODE, str(HERE / "ts_server.mjs"), json.dumps(options)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )  # type: ignore[list-item]
        line = self.proc.stdout.readline()  # type: ignore[union-attr]
        if not line:
            raise RuntimeError(self.proc.stderr.read())  # type: ignore[union-attr]
        self.url = f"http://127.0.0.1:{json.loads(line)['port']}"

    def facilitator_log(self) -> list[dict[str, Any]]:
        self.proc.kill()
        _, err = self.proc.communicate()
        return [json.loads(line) for line in err.splitlines() if line.startswith("{")]


@pytest.fixture
def ts_seller() -> Iterator[Any]:
    started: list[TsSeller] = []

    def start(**options: Any) -> TsSeller:
        s = TsSeller(**options)
        started.append(s)
        return s

    yield start
    for s in started:
        if s.proc.poll() is None:
            s.proc.kill()


def rpc_stub(allowance: int = 0, nonce: int = 0) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["method"] == "eth_chainId":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": hex(72344)})
        selector = body["params"][0].get("data", "")[:10] if body["method"] == "eth_call" else ""
        value = allowance if selector == "0xdd62ed3e" else nonce
        return httpx.Response(
            200, json={"jsonrpc": "2.0", "id": body["id"], "result": "0x" + hex(value)[2:].rjust(64, "0")}
        )

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def py_buyer(**kw: Any) -> Any:
    return create_radius_fetch(network="testnet", signer=PK, max_per_request="$0.05", rpc_http_client=rpc_stub(), **kw)


class TestPythonBuyerTypeScriptSeller:
    @pytest.mark.parametrize("settle", ["before", "after"])
    async def test_pays_exact_eip3009(self, ts_seller: Any, settle: str) -> None:
        seller = ts_seller(settle=settle)
        res = await py_buyer()(seller.url + "/api/lookup")
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["ok"] is True
        assert body["paidBy"] == (SIGNER.address if settle == "before" else None)
        receipt = get_payment_receipt(res, radius_testnet)
        assert receipt and (receipt.success, receipt.transaction, receipt.payer) == (
            True,
            "0x" + "cd" * 32,
            SIGNER.address,
        )
        ops = [e["op"] for e in seller.facilitator_log() if "error" not in e]
        assert ops == (["settle"] if settle == "before" else ["verify", "settle"])

    async def test_pays_a_post_with_its_body(self, ts_seller: Any) -> None:
        seller = ts_seller()
        res = await py_buyer().post(seller.url + "/api/query", json={"q": "radius"})
        assert res.status_code == 200
        assert json.loads(res.json()["body"]) == {"q": "radius"}
        [settle] = [e for e in seller.facilitator_log() if e.get("op") == "settle"]
        assert settle["requirements"]["amount"] == "10000"

    async def test_pays_permit2_with_a_sponsored_eip2612_permit(self, ts_seller: Any) -> None:
        seller = ts_seller(methods=["permit2"])
        res = await py_buyer()(seller.url + "/api/lookup")
        assert res.status_code == 200, res.text
        [settle] = [e for e in seller.facilitator_log() if e.get("op") == "settle"]
        assert settle["payload"]["payload"]["permit2Authorization"]["from"] == SIGNER.address
        info = settle["payload"]["extensions"]["eip2612GasSponsoring"]["info"]
        assert (info["spender"], info["amount"]) == ("0x000000000022D473030F116dDEE9F6B43aC78BA3", "1000")
        assert "schema" in settle["payload"]["extensions"]["eip2612GasSponsoring"]  # the server's declaration is kept

    async def test_pays_over_mpp(self, ts_seller: Any) -> None:
        seller = ts_seller(mpp=True)
        res = await py_buyer(protocols=["mpp"])(seller.url + "/api/lookup")
        assert res.status_code == 200, res.text
        receipt = get_payment_receipt(res, radius_testnet)
        assert receipt and (receipt.protocol, receipt.transaction) == ("mpp", "0x" + "cd" * 32)
        [settle] = [e for e in seller.facilitator_log() if e.get("op") == "settle"]
        assert settle["payload"]["payload"]["authorization"]["from"] == SIGNER.address

    async def test_both_sellers_answer_the_same_402(self, ts_seller: Any) -> None:
        seller = ts_seller(mpp=True, realm="shop.test")
        async with httpx.AsyncClient() as http:
            ts = await http.get(seller.url + "/api/lookup")
        pay = radius_payments(
            network="testnet",
            pay_to=PAY_TO,
            facilitator=MockFacilitator(radius_testnet),
            mpp={"secret_key": SECRET, "realm": "shop.test"},
            routes={"GET /api/lookup": {"price": "$0.001", "description": "One lookup"}, "POST /api/query": "$0.01"},
        )
        from starlette.applications import Starlette
        from starlette.responses import JSONResponse
        from starlette.routing import Route

        app = Starlette(routes=[Route("/api/lookup", pay.wrap(lambda r: JSONResponse({})))])
        async with asgi_client(app) as http:
            py = await http.get("/api/lookup")
        assert (ts.status_code, ts.json()) == (py.status_code, py.json())
        assert ts.headers["cache-control"] == py.headers["cache-control"]
        a, b = from_b64(ts.headers["payment-required"]), from_b64(py.headers["payment-required"])
        a["resource"]["url"] = b["resource"]["url"] = "<url>"
        assert a == b
        [ca], [cb] = (
            parse_mpp_challenges(ts.headers["www-authenticate"]),
            parse_mpp_challenges(py.headers["www-authenticate"]),
        )
        assert (ca.request_encoded, ca.realm, ca.description, ca.method, ca.intent) == (
            cb.request_encoded,
            cb.realm,
            cb.description,
            cb.method,
            cb.intent,
        )


# -- TypeScript buyer → Python seller --------------------------------------------------------------


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class PySeller:
    """The Python handler under uvicorn on a background thread, settled by a signature-checking mock facilitator."""

    def __init__(self, **options: Any) -> None:
        import uvicorn
        from starlette.applications import Starlette
        from starlette.requests import Request
        from starlette.responses import JSONResponse
        from starlette.routing import Route

        self.facilitator = MockFacilitator(radius_testnet, methods=options.pop("methods", ("eip3009", "permit2")))
        pay = radius_payments(
            network="testnet",
            pay_to=PAY_TO,
            facilitator=self.facilitator,
            routes={"GET /api/lookup": {"price": "$0.001", "description": "One lookup"}, "POST /api/query": "$0.01"},
            **options,
        )

        async def handler(request: Request, payment: Any) -> JSONResponse:
            body = (await request.body()).decode() if request.method != "GET" else None
            return JSONResponse(
                {"ok": True, "method": request.method, "body": body, "paidBy": payment.payer if payment else None}
            )

        app = Starlette(routes=[Route("/api/{name}", pay.wrap(handler), methods=["GET", "POST"])])
        self.port = _free_port()
        self.server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning", lifespan="off")
        )
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        deadline = time.monotonic() + 10
        while not self.server.started:
            if time.monotonic() > deadline:
                raise RuntimeError("uvicorn did not start")
            time.sleep(0.01)
        self.url = f"http://127.0.0.1:{self.port}"

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(5)


class RpcStubServer:
    """A JSON-RPC stub over HTTP for the TypeScript buyer (allowance 0, EIP-2612 nonce 0, chain 72344)."""

    def __init__(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                calls = body if isinstance(body, list) else [body]
                answers = [
                    {
                        "jsonrpc": "2.0",
                        "id": c["id"],
                        "result": hex(72344) if c["method"] == "eth_chainId" else "0x" + "0" * 64,
                    }
                    for c in calls
                ]
                data = json.dumps(answers if isinstance(body, list) else answers[0]).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: Any) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def stop(self) -> None:
        self.httpd.shutdown()


@pytest.fixture
def py_seller() -> Iterator[Any]:
    started: list[PySeller] = []

    def start(**options: Any) -> PySeller:
        s = PySeller(**options)
        started.append(s)
        return s

    yield start
    for s in started:
        s.stop()


async def ts_buyer(url: str, **options: Any) -> dict[str, Any]:
    args = json.dumps({"url": url, "privateKey": PK, **options})
    proc = await asyncio.create_subprocess_exec(
        NODE, str(HERE / "ts_buyer.mjs"), args, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )  # type: ignore[arg-type]
    out, err = await asyncio.wait_for(proc.communicate(), 60)
    assert proc.returncode == 0, err.decode()
    return json.loads(out)


class TestTypeScriptBuyerPythonSeller:
    @pytest.mark.parametrize("settle", ["before", "after"])
    async def test_pays_exact_eip3009(self, py_seller: Any, settle: str) -> None:
        seller = py_seller(settle=settle)
        result = await ts_buyer(seller.url + "/api/lookup")
        assert result.get("status") == 200, result
        body = json.loads(result["body"])
        assert body["paidBy"] == (SIGNER.address if settle == "before" else None)
        assert result["receipt"]["transaction"] == "0x" + "ab" * 32
        assert result["offer"] == {
            "protocol": "x402",
            "scheme": "exact",
            "amount": "1000",
            "payTo": PAY_TO,
            "transferMethod": "eip3009",
            "x402Version": 2,
        }
        [(payload, requirements)] = seller.facilitator.settled
        assert recover_eip3009(72344, requirements.asset, "Stable Coin", "1", payload.payload) == SIGNER.address

    async def test_pays_a_post_with_its_body(self, py_seller: Any) -> None:
        seller = py_seller()
        result = await ts_buyer(
            seller.url + "/api/query",
            init={"method": "POST", "body": '{"q":"radius"}', "headers": {"content-type": "application/json"}},
        )
        assert result.get("status") == 200, result
        assert json.loads(json.loads(result["body"])["body"]) == {"q": "radius"}
        assert seller.facilitator.settled[0][1].amount == "10000"

    async def test_pays_permit2_with_a_sponsored_eip2612_permit(self, py_seller: Any) -> None:
        rpc = RpcStubServer()
        try:
            seller = py_seller(methods=("permit2",))
            result = await ts_buyer(seller.url + "/api/lookup", rpcUrl=rpc.url)
        finally:
            rpc.stop()
        assert result.get("status") == 200, result
        assert result["offer"]["transferMethod"] == "permit2"
        [(payload, _)] = seller.facilitator.settled
        assert payload.payload["permit2Authorization"]["from"] == SIGNER.address
        assert (
            payload.extensions["eip2612GasSponsoring"]["info"]["spender"]
            == "0x000000000022D473030F116dDEE9F6B43aC78BA3"
        )

    async def test_pays_over_mpp(self, py_seller: Any) -> None:
        seller = py_seller(mpp={"secret_key": SECRET})
        result = await ts_buyer(seller.url + "/api/lookup", protocols=["mpp"])
        assert result.get("status") == 200, result
        assert (result["receipt"]["protocol"], result["receipt"]["transaction"]) == ("mpp", "0x" + "ab" * 32)
        assert result["offer"]["protocol"] == "mpp"
        [(payload, requirements)] = seller.facilitator.settled
        assert recover_eip3009(72344, requirements.asset, "Stable Coin", "1", payload.payload) == SIGNER.address

    async def test_a_python_402_after_payment_reaches_the_ts_buyer_as_payment_rejected(self, py_seller: Any) -> None:
        seller = py_seller()
        seller.facilitator.settle_success = False
        result = await ts_buyer(seller.url + "/api/lookup")
        assert result["error"] == "payment_rejected", result
