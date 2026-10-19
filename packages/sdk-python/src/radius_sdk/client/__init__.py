"""Make payments (buyer / agent): an ``httpx``-based client that pays x402 and MPP challenges automatically.

A port of the TypeScript SDK's ``createRadiusFetch`` (``radius-sdk/client``), with the same offer
selection, per-request ceiling, approval gate, redirect rules and error codes::

    pay = create_radius_fetch(network="testnet", signer=os.environ["RADIUS_PRIVATE_KEY"], max_per_request="$0.05")
    res = await pay("https://seller.example/api/lookup?ip=1.2.3.4")
    receipt = get_payment_receipt(res, pay.network)

Needs ``pip install 'radius-sdk[client]'`` (eth-account and the x402 EVM schemes).
"""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import functools
import inspect
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal, Union

import httpx
from eth_utils import is_address, to_checksum_address
from x402 import x402ClientSync
from x402.mechanisms.evm.exact.client import ExactEvmScheme
from x402.mechanisms.evm.upto.client import UptoEvmScheme
from x402.schemas import PaymentRequired, PaymentRequirements
from x402.schemas.v1 import PaymentRequiredV1, PaymentRequirementsV1

from ..amounts import Price, format_amount, resolve_price
from ..balances import BALANCE_OF as BALANCE_OF_FN
from ..balances import AccountBalances, get_balances
from ..eip712 import AccountSigner, sign_typed_data, to_signer
from ..erc20 import ALLOWANCE, APPROVE, TRANSFER, TokenAmount, TxResult, to_token_atomic
from ..errors import RadiusPaymentError
from ..mpp import (
    MPP_INTENT,
    MPP_METHOD,
    MPP_RECEIPT_HEADER,
    MppChallenge,
    mpp_challenge_nonce,
    mpp_source,
    parse_mpp_challenges,
    serialize_mpp_credential,
)
from ..networks import (
    PERMIT2_ADDRESS,
    NetworkInput,
    PaymentAsset,
    PaymentNetwork,
    explorer_tx_url,
    is_network_id,
    overrides_of,
    resolve_network,
)
from ..receipt import (
    PaymentReceipt,
    decode_header_json,
    decode_mpp_receipt,
    decode_payment_receipt,
    get_payment_receipt,
    parse_upto_settlement_amount,
)
from ..rpc import AbiFunction, RpcClient, WalletClient
from ..schemes import describe_supported_schemes
from ..settlement import Settlement, get_settlement

logger = logging.getLogger("radius_sdk")

PaymentScheme = Literal["exact", "upto"]
PaymentProtocol = Literal["x402", "mpp"]

MAX_UINT256 = 2**256 - 1
#: Longest signing window we will authorise, and the default when a challenge omits
#: ``maxTimeoutSeconds``. An authorisation the facilitator fails to settle stays redeemable until its
#: deadline, so the server's value is clamped rather than trusted (matches radius-cli).
MAX_TIMEOUT_SECONDS = 600
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
MAX_REDIRECTS = 20
SPONSORING_KEYS = ("eip2612GasSponsoring", "erc20ApprovalGasSponsoring")
_ATOMIC = re.compile(r"^[0-9]+$")
_PAYMENT_AUTH = re.compile(r"^payment\s", re.IGNORECASE)
_BODY_HEADERS = ("content-encoding", "content-language", "content-location", "content-type")
_CROSS_ORIGIN_DROPPED = ("authorization", "cookie", "proxy-authorization")


@dataclass
class Resource:
    url: str
    description: str | None = None
    mime_type: str | None = None


@dataclass
class X402Offer:
    """An x402 offer: an entry of the 402's ``accepts``."""

    #: ``exact``: pay exactly ``amount``. ``upto``: authorise up to ``amount``; the facilitator charges what was used.
    scheme: PaymentScheme
    #: Atomic amount, e.g. "10000". For ``upto`` this is the authorised maximum.
    amount: str
    #: Display amount, e.g. "0.01 SBC".
    amount_formatted: str
    asset: str
    pay_to: str
    #: The network the offer pays on (one of the client's ``networks``).
    network: PaymentNetwork
    resource: Resource
    #: How the asset moves: ``permit2`` needs a one-time ERC-20 approval (unless sponsored), ``eip3009`` does not.
    transfer_method: Literal["permit2", "eip3009"]
    #: True when the server's facilitator will sponsor the one-time Permit2 approval.
    gas_sponsored: bool
    #: x402 protocol version of the challenge: v1 pays with ``X-PAYMENT``, v2 with ``PAYMENT-SIGNATURE``.
    x402_version: Literal[1, 2]
    #: Untouched requirement chosen from the 402 (a v1 entry when ``x402_version`` is 1).
    requirements: dict[str, Any]
    protocol: Literal["x402"] = "x402"


@dataclass
class MppOffer:
    """An MPP offer: a ``WWW-Authenticate: Payment`` challenge for an ``evm`` charge, paid by EIP-3009 authorization."""

    amount: str
    amount_formatted: str
    asset: str
    pay_to: str
    network: PaymentNetwork
    resource: Resource
    #: The challenge as received, echoed back in the credential.
    challenge: MppChallenge
    scheme: Literal["exact"] = "exact"
    transfer_method: Literal["eip3009"] = "eip3009"
    gas_sponsored: bool = False
    protocol: Literal["mpp"] = "mpp"


PaymentOffer = Union[X402Offer, MppOffer]


@dataclass
class ApprovalRequest:
    """An allowance change the client is about to make, handed to ``on_approval_required`` before anything is signed.

    Every path that changes an allowance goes through it: the automatic Permit2 approval during a
    payment (``reason='payment'``, with the ``offer``), an explicit ``approve_permit2()`` and
    ``approve(spender, amount)``. The request is also the ``details`` of the ``declined`` error.
    """

    reason: Literal["payment", "approvePermit2", "approve"]
    network: PaymentNetwork
    asset: str
    spender: str
    #: Unlimited for Permit2 (the x402 "one-time gas approval" model), the caller's amount for ``approve``.
    amount: int
    current_allowance: int
    offer: PaymentOffer | None = None
    #: Set when no transaction is sent by this client: the allowance is granted by a signed raw
    #: ``approve`` transaction that the server's facilitator submits.
    sponsored: Literal["erc20Approval"] | None = None


@dataclass
class PaymentRejectedDetails:
    """``details`` of a ``payment_rejected`` error: the server's second 402."""

    response: httpx.Response
    #: ``error`` from the decoded ``PAYMENT-REQUIRED`` header (x402), or the problem ``detail`` (MPP).
    error: str | None = None
    challenge: dict[str, Any] | None = None


@dataclass
class InvalidChallengeDetails:
    """``details`` of an ``invalid_challenge`` error raised while parsing a 402."""

    response: httpx.Response
    body: str | None = None
    cause: Any = None


@dataclass
class FaucetResult:
    success: bool
    #: Display amount dripped, e.g. "0.5".
    amount: str | None = None
    tx_hash: str | None = None
    raw: Any = None


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def _same_origin(a: httpx.URL, b: httpx.URL) -> bool:
    return a.scheme == b.scheme and a.host == b.host and a.port == b.port


# -- signers --------------------------------------------------------------------------------------


class _SchemeSigner:
    """The signer handed to the x402 EVM schemes, which run synchronously in a worker thread.

    On-chain reads (EIP-2612 nonce, Permit2 allowance) and the pending nonce for a sponsored raw
    approve are answered by the rail's async RPC client on the caller's event loop.
    """

    def __init__(self, signer: Any, rail: _Rail, loop: asyncio.AbstractEventLoop | None = None) -> None:
        self._signer = signer
        self._rail = rail
        self.loop = loop
        account = getattr(signer, "account", None)
        if account is not None and hasattr(account, "sign_transaction"):
            self.sign_transaction = signer.sign_transaction  # type: ignore[method-assign]
            self.get_transaction_count = self._get_transaction_count  # type: ignore[method-assign]

    @property
    def address(self) -> str:
        return self._signer.address

    def sign_typed_data(self, domain: Any, types: Any, primary_type: str, message: dict[str, Any]) -> bytes:
        return self._signer.sign_typed_data(domain, types, primary_type, message)

    def _run(self, coro: Awaitable[Any]) -> Any:
        if self.loop is None:
            raise RuntimeError("radius-sdk: scheme signer used outside a payment")
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result()  # type: ignore[arg-type]

    def read_contract(self, address: str, abi: list[dict[str, Any]], function_name: str, *args: Any) -> Any:
        entry = next(
            (e for e in abi if e.get("type", "function") == "function" and e.get("name") == function_name), None
        )
        if entry is None:
            raise ValueError(f"read_contract: {function_name} is not in the ABI")
        fn = AbiFunction(
            function_name,
            tuple(i["type"] for i in entry.get("inputs", [])),
            tuple(o["type"] for o in entry.get("outputs", [])),
        )
        return self._run(self._rail.rpc.read_contract(address, fn, *args))

    def _get_transaction_count(self, address: str) -> int:
        return int(self._run(self._rail.rpc.request("eth_getTransactionCount", [address, "pending"])), 16)

    def estimate_fees_per_gas(self) -> tuple[int, int]:
        async def fees() -> tuple[int, int]:
            block = await self._rail.rpc.request("eth_getBlockByNumber", ["latest", False])
            base = int(block.get("baseFeePerGas") or "0x3b9aca00", 16)
            try:
                priority = int(await self._rail.rpc.request("eth_maxPriorityFeePerGas"), 16)
            except Exception:
                priority = 1_500_000_000
            return base * 2 + priority, priority

        return self._run(fees())


@dataclass
class _Rail:
    """Per-network state: clients, x402 signer, cap. Built once, up front; nothing here does I/O."""

    network: PaymentNetwork
    cap: int
    rpc: RpcClient
    #: None when the signer cannot send transactions.
    wallet: WalletClient | None
    no_wallet_reason: str | None
    scheme_signer: _SchemeSigner = field(init=False)


@dataclass
class _Candidate:
    """An offer that passed every check but the balance one; built into a :data:`PaymentOffer` only once chosen."""

    rail: _Rail
    amount: int
    build: Callable[[], PaymentOffer]


class _ExactV1Scheme:
    """x402 v1 ``exact`` is EIP-3009 only. Radius appears in v1 challenges as ``eip155:<chainId>``,
    which the x402 v1 scheme's named-network table rejects; the v2 scheme's EIP-3009 signing is
    version-agnostic, so delegate to it with the v1 price field and network normalised."""

    scheme = "exact"

    def __init__(self, exact: ExactEvmScheme, network: PaymentNetwork) -> None:
        self._exact = exact
        self._network = network

    def create_payment_payload(self, requirements: PaymentRequirementsV1) -> dict[str, Any]:
        extra = {k: v for k, v in (requirements.extra or {}).items() if k != "assetTransferMethod"}
        v2 = PaymentRequirements(
            scheme=requirements.scheme,
            network=self._network.network,
            asset=requirements.asset,
            amount=requirements.max_amount_required,
            pay_to=requirements.pay_to,
            max_timeout_seconds=requirements.max_timeout_seconds,
            extra=extra,
        )
        return self._exact.create_payment_payload(v2)


# -- wallet helpers -------------------------------------------------------------------------------


class NetworkWallet:
    """Wallet helpers bound to one network. :class:`RadiusFetch` itself is the one for its first network."""

    def __init__(self, owner: RadiusFetch, rail: _Rail) -> None:
        self._owner = owner
        self._rail = rail

    @property
    def network(self) -> PaymentNetwork:
        return self._rail.network

    @property
    def max_per_request(self) -> int:
        """Atomic cap per request in this network's asset."""
        return self._rail.cap

    @property
    def address(self) -> str:
        return self._owner.address

    async def balance(self) -> tuple[int, str]:
        """Payment-asset balance of the signer, ``(atomic, formatted)``: a raw ERC-20 ``balanceOf``, nothing aggregated."""
        asset = self.network.asset
        atomic = int(await self._rail.rpc.read_contract(asset.address, BALANCE_OF_FN, self.address))
        return atomic, format_amount(atomic, asset.decimals, asset.symbol)

    async def balances(self) -> AccountBalances:
        """Native RUSD, payment-asset and aggregate balances of the signer, reported separately."""
        return await get_balances(self._rail.rpc, self.address, network=self.network)

    async def allowance(self, spender: str) -> int:
        """Payment-asset allowance the signer has granted to ``spender`` (atomic units)."""
        return int(await self._rail.rpc.read_contract(self.network.asset.address, ALLOWANCE, self.address, spender))

    async def permit2_allowance(self) -> int:
        """Current ERC-20 allowance granted to Permit2 for the payment asset."""
        return await self.allowance(PERMIT2_ADDRESS)

    async def _send_tx(self, what: str, to: str, fn: AbiFunction, *args: Any) -> TxResult:
        wallet = self._rail.wallet
        if wallet is None:
            raise RadiusPaymentError(
                "approval_required",
                f"{what} needs a transaction-capable signer on {self.network.name} (a private key or eth-account LocalAccount); {self._rail.no_wallet_reason}",
            )
        tx_hash = await wallet.write_contract(to, fn, *args)
        receipt = await wallet.wait_for_transaction_receipt(tx_hash)
        status = "success" if receipt.get("status") in ("0x1", 1) else "reverted"
        return TxResult(tx_hash, status, explorer_tx_url(self.network, tx_hash))  # type: ignore[arg-type]

    async def _send_approval(self, request: ApprovalRequest, what: str) -> TxResult:
        await self._owner._authorize_approval(request)
        r = await self._send_tx(what, self.network.asset.address, APPROVE, request.spender, request.amount)
        if r.status != "success":
            raise RadiusPaymentError("approval_failed", f"{what} transaction {r.hash} reverted", r)
        return r

    async def approve_permit2(self) -> TxResult:
        """Send an unlimited Permit2 approval now (rather than lazily on first unsponsored payment). Subject to ``on_approval_required``."""
        current = await self.permit2_allowance()
        request = ApprovalRequest(
            "approvePermit2", self.network, self.network.asset.address, PERMIT2_ADDRESS, MAX_UINT256, current
        )
        return await self._send_approval(request, "Permit2 approval")

    async def approve(self, spender: str, amount: TokenAmount) -> TxResult:
        """Approve ``spender`` for ``amount`` of the payment asset (int atomic, or "1.5" display units). Subject to ``on_approval_required``."""
        atomic, current = await asyncio.gather(
            to_token_atomic(self._rail.rpc, self.network.asset, amount), self.allowance(spender)
        )
        return await self._send_approval(
            ApprovalRequest("approve", self.network, self.network.asset.address, spender, atomic, current), "approve"
        )

    async def send(self, to: str, amount: Price) -> TxResult:
        """Transfer the payment asset. Needs a transaction-capable signer (private key or eth-account LocalAccount)."""
        atomic = int(resolve_price(amount, self.network.asset)["amount"])
        return await self._send_tx("send", self.network.asset.address, TRANSFER, to, atomic)

    async def get_settlement(self, tx_hash: str) -> Settlement | None:
        """Reconcile a settlement transaction on-chain (None while unknown to the node)."""
        return await get_settlement(self.network, tx_hash, self._rail.rpc)

    async def fund(self) -> FaucetResult:
        """Request a faucet drip for this wallet (Radius testnet ~0.5 SBC; mainnet ~0.01 SBC/day)."""
        network = self.network
        if not network.faucet_url:
            raise RadiusPaymentError("faucet", f"No faucet configured for network {network.name}")
        sign_message = getattr(self._owner._signer, "sign_message", None)
        if not callable(sign_message):
            raise RadiusPaymentError(
                "faucet",
                "fund() needs a signer with sign_message (EIP-191), e.g. a private key or eth-account LocalAccount",
            )
        base = network.faucet_url.rstrip("/")
        token = network.asset.symbol
        http = self._owner._http
        challenge = (await http.get(f"{base}/challenge/{self.address}", params={"token": token})).json()
        message = challenge.get("message") if isinstance(challenge, dict) else None
        if not message:
            raise RadiusPaymentError("faucet", "Faucet returned no challenge message", challenge)
        signature = await _maybe_await(sign_message(message))
        res = await http.post(f"{base}/drip", json={"address": self.address, "token": token, "signature": signature})
        try:
            raw = res.json()
        except ValueError:
            raw = {}
        if not res.is_success or not isinstance(raw, dict) or raw.get("success") is not True:
            err = (raw.get("error") if isinstance(raw, dict) else None) or {}
            raise RadiusPaymentError(
                "faucet",
                f"Faucet drip failed: {err.get('code', res.status_code)} {err.get('message', '')}".strip(),
                raw,
            )
        return FaucetResult(success=True, amount=raw.get("amount"), tx_hash=raw.get("tx_hash"), raw=raw)


# -- the paying client ----------------------------------------------------------------------------


@dataclass
class _Prepared:
    method: str
    url: httpx.URL
    headers: httpx.Headers
    body: bytes | None


class RadiusFetch(NetworkWallet):
    """An ``httpx``-based client that pays x402 (and MPP) challenges within a per-request ceiling.

    Call it like ``await pay(url, method=..., headers=..., content=... | json=...)``, or use
    :meth:`request` / :meth:`get` / :meth:`post`. Returns the ``httpx.Response`` (body read). The wallet
    helpers on it are for the first network; :meth:`on` gives them for the others.
    """

    def __init__(self, **options: Any) -> None:
        self._configure(**options)
        super().__init__(self, self._rails[0])

    def _configure(
        self,
        *,
        signer: Any,
        max_per_request: Price,
        network: NetworkInput | None = None,
        networks: Sequence[NetworkInput] | None = None,
        protocols: Sequence[PaymentProtocol] | None = None,
        prefer_funded: bool = True,
        on_payment_required: Callable[[PaymentOffer], bool | Awaitable[bool]] | None = None,
        permit2_approval: Literal["auto", "never"] = "auto",
        on_approval_required: Callable[[ApprovalRequest], bool | Awaitable[bool]] | None = None,
        on_paid: Callable[[PaymentReceipt, PaymentOffer], Any] | None = None,
        http_client: httpx.AsyncClient | None = None,
        rpc_http_client: httpx.AsyncClient | None = None,
        rpc_url: str | None = None,
        facilitator_url: str | None = None,
        explorer_url: str | None = None,
        faucet_url: str | None = None,
        asset: Mapping[str, Any] | PaymentAsset | None = None,
        facilitator: Any = None,
        pay_to: Any = None,
    ) -> None:
        # `facilitator` and `pay_to` are seller options: accepted (and ignored) so `**radius_env()` spreads cleanly.
        del facilitator, pay_to
        if network is not None and networks is not None:
            raise RadiusPaymentError("config", "create_radius_fetch: pass network or networks, not both")
        if networks is not None and len(networks) == 0:
            raise RadiusPaymentError("config", "create_radius_fetch: networks is empty")
        overrides = overrides_of(
            rpc_url=rpc_url,
            facilitator_url=facilitator_url,
            explorer_url=explorer_url,
            faucet_url=faucet_url,
            asset=asset,
        )
        inputs = list(networks) if networks is not None else [network]
        resolved = [resolve_network(n, overrides) if i == 0 else resolve_network(n) for i, n in enumerate(inputs)]
        seen: set[int] = set()
        for n in resolved:
            if n.chain_id in seen:
                raise RadiusPaymentError(
                    "config", f"create_radius_fetch: chain {n.chain_id} ({n.name}) is listed twice"
                )
            seen.add(n.chain_id)
        if max_per_request is None:
            raise RadiusPaymentError("config", 'create_radius_fetch: max_per_request is required (e.g. "$0.05")')
        chosen = list(dict.fromkeys(protocols if protocols is not None else ("x402", "mpp")))
        if not chosen or any(p not in ("x402", "mpp") for p in chosen):
            raise RadiusPaymentError(
                "config", f"create_radius_fetch: protocols must list 'x402' and/or 'mpp' (got {protocols!r})"
            )
        if permit2_approval not in ("auto", "never"):
            raise RadiusPaymentError(
                "config", f"create_radius_fetch: permit2_approval must be 'auto' or 'never' (got {permit2_approval!r})"
            )

        try:
            self._signer = to_signer(signer)
        except TypeError as e:
            raise RadiusPaymentError("config", f"create_radius_fetch: {e}") from e
        local = self._signer.account if isinstance(self._signer, AccountSigner) else None

        self.networks: tuple[PaymentNetwork, ...] = tuple(resolved)
        self.protocols: tuple[PaymentProtocol, ...] = tuple(chosen)  # type: ignore[arg-type]
        self._prefer_funded = prefer_funded
        self._on_payment_required = on_payment_required
        self._permit2_approval = permit2_approval
        self._on_approval_required = on_approval_required
        self._on_paid = on_paid
        self._http = http_client or httpx.AsyncClient(timeout=httpx.Timeout(60.0))
        self._owns_http = http_client is None
        self._rails: list[_Rail] = []
        for n in resolved:
            rpc = RpcClient.for_network(n, http_client=rpc_http_client)
            wallet = WalletClient.for_network(n, local, http_client=rpc_http_client) if local is not None else None
            try:
                cap = int(resolve_price(max_per_request, n.asset)["amount"])
            except ValueError as e:
                raise RadiusPaymentError("config", f"create_radius_fetch: max_per_request: {e}") from e
            rail = _Rail(n, cap, rpc, wallet, None if local is not None else "this signer can only sign typed data")
            rail.scheme_signer = _SchemeSigner(self._signer, rail)
            self._rails.append(rail)
        self._wallets = {id(r): NetworkWallet(self, r) for r in self._rails}

        client = x402ClientSync()
        assets: list[Any] = []
        for rail in self._rails:
            exact = ExactEvmScheme(rail.scheme_signer)
            v1 = _ExactV1Scheme(exact, rail.network)
            client.register(rail.network.network, exact).register(
                rail.network.network, UptoEvmScheme(rail.scheme_signer)
            )
            client.register_v1(rail.network.network, v1)
            for name in rail.network.v1_names:
                client.register_v1(name, v1)
            for net_id in (rail.network.network, *rail.network.v1_names):
                assets.append(
                    {"network": net_id, "asset": rail.network.asset.address, "max_amount_per_payment": str(rail.cap)}
                )
        # Backstop; the primary checks live in `_x402_candidates` so errors are typed.
        client.set_spend_controls({"max_amount_per_payment": False, "allowed_assets": assets})  # type: ignore[typeddict-item]
        #: Escape hatch to the underlying x402 client.
        self.client = client

    # -- public surface -------------------------------------------------------------------------

    @property
    def address(self) -> str:
        return self._signer.address

    def on(self, network: str | PaymentNetwork) -> NetworkWallet:
        """Wallet helpers for one of ``networks``, by preset id, CAIP-2 id, v1 name or the network itself."""
        rail = self._rail_for(network)
        if rail is None:
            name = network if isinstance(network, str) else f"{network.name} ({network.network})"
            raise RadiusPaymentError(
                "config", f"{name} is not one of this client's networks: {self._describe_networks()}"
            )
        return self._wallets[id(rail)]

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()
        for rail in self._rails:
            await rail.rpc.aclose()
            if rail.wallet is not None:
                await rail.wallet.aclose()

    async def __aenter__(self) -> RadiusFetch:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def get(self, url: str | httpx.URL, **kw: Any) -> httpx.Response:
        return await self(url, method="GET", **kw)

    async def post(self, url: str | httpx.URL, **kw: Any) -> httpx.Response:
        return await self(url, method="POST", **kw)

    async def put(self, url: str | httpx.URL, **kw: Any) -> httpx.Response:
        return await self(url, method="PUT", **kw)

    async def delete(self, url: str | httpx.URL, **kw: Any) -> httpx.Response:
        return await self(url, method="DELETE", **kw)

    async def head(self, url: str | httpx.URL, **kw: Any) -> httpx.Response:
        return await self(url, method="HEAD", **kw)

    async def request(self, method: str, url: str | httpx.URL, **kw: Any) -> httpx.Response:
        return await self(url, method=method, **kw)

    async def __call__(
        self,
        url: str | httpx.URL | httpx.Request,
        *,
        method: str = "GET",
        headers: Mapping[str, str] | Sequence[tuple[str, str]] | None = None,
        params: Any = None,
        content: bytes | str | None = None,
        data: Any = None,
        json: Any = None,
    ) -> httpx.Response:
        if isinstance(url, httpx.Request):
            req = url
            body = await req.aread()
        else:
            req = self._http.build_request(
                method.upper(), url, headers=headers, params=params, content=content, data=data, json=json
            )
            body = await req.aread()
        prepared = _Prepared(req.method, req.url, httpx.Headers(req.headers), body if body else None)
        return await self._paid_fetch(prepared)

    # -- internals ------------------------------------------------------------------------------

    def _rail_for(self, id: str | PaymentNetwork) -> _Rail | None:
        if not isinstance(id, str):
            return next((r for r in self._rails if r.network is id or r.network.chain_id == id.chain_id), None)
        try:
            preset_chain: int | None = resolve_network(id).chain_id
        except ValueError:
            preset_chain = None
        return next(
            (
                r
                for r in self._rails
                if id == r.network.name or is_network_id(r.network, id) or r.network.chain_id == preset_chain
            ),
            None,
        )

    def _describe_networks(self) -> str:
        return ", ".join(f"{r.network.network} ({r.network.name})" for r in self._rails)

    def _describe_assets(self) -> str:
        return ", ".join(
            f"{r.network.asset.symbol} ({r.network.asset.address}) on {r.network.network}" for r in self._rails
        )

    async def _authorize_approval(self, request: ApprovalRequest) -> None:
        """The one policy gate for allowance changes: ``on_approval_required`` may veto, else proceed."""
        if self._on_approval_required is not None and not await _maybe_await(self._on_approval_required(request)):
            what = "Permit2" if request.reason == "payment" else request.reason
            raise RadiusPaymentError("declined", f"{what} approval declined", request)

    async def _send(self, p: _Prepared, *, follow: bool) -> tuple[httpx.Response, httpx.URL, bool]:
        """Send ``p``; with ``follow``, follow redirects by fetch's rules. Returns (response, final URL, redirected)."""
        method, url, headers, body = p.method, p.url, httpx.Headers(p.headers), p.body
        redirected = False
        for _ in range(MAX_REDIRECTS + 1):
            request = self._http.build_request(method, url, headers=headers, content=body)
            response = await self._http.send(request, follow_redirects=False)
            location = response.headers.get("location") if response.status_code in REDIRECT_STATUSES else None
            if not follow or not location:
                return response, url, redirected
            await response.aclose()
            next_url = url.join(location)
            to_get = (response.status_code == 303 and method not in ("GET", "HEAD")) or (
                response.status_code in (301, 302) and method == "POST"
            )
            if to_get:
                method, body = "GET", None
                for h in _BODY_HEADERS:
                    headers.pop(h, None)
                headers.pop("content-length", None)
            if not _same_origin(next_url, url):
                for h in _CROSS_ORIGIN_DROPPED:
                    headers.pop(h, None)
            headers.pop("host", None)
            url = next_url
            redirected = True
        raise httpx.TooManyRedirects("Exceeded maximum allowed redirects.", request=request)

    async def _paid_fetch(self, request: _Prepared) -> httpx.Response:
        h = request.headers
        if "payment-signature" in h or "x-payment" in h or _PAYMENT_AUTH.match(h.get("authorization") or ""):
            return (await self._send(request, follow=True))[0]
        # The paid retry never follows redirects: a 3xx must not carry the payment header to another origin.
        retry = dataclasses.replace(request, headers=httpx.Headers(request.headers))
        first, final_url, redirected = await self._send(request, follow=True)
        if first.status_code != 402:
            return first
        # The request followed redirects before the 402. We pay at the URL that answered it, not the
        # redirector, and replay the ORIGINAL method and body there (leaving Authorization and Cookie
        # behind on another origin). This matches @x402/fetch and the TypeScript SDK; the x402 spec says
        # nothing about redirects or methods. Known hazard: after a 301/302/303 the 402 saw only a GET,
        # yet the paid retry sends the POST with its body (307/308 keep the POST throughout).
        if redirected:
            retry.url = final_url
            retry.headers.pop("host", None)
            if not _same_origin(final_url, request.url):
                for name in ("authorization", "cookie"):
                    retry.headers.pop(name, None)

        offer, x402 = await self._select_offer(first, retry)
        if self._on_payment_required is not None and not await _maybe_await(self._on_payment_required(offer)):
            raise RadiusPaymentError(
                "declined", f"Payment of {offer.amount_formatted} to {offer.pay_to} declined", offer
            )

        unpaid = httpx.Headers(retry.headers)  # what a redirect after payment may carry on: no payment headers
        if isinstance(offer, X402Offer):
            assert x402 is not None
            withheld = await self._ensure_allowance(offer, x402.get("extensions"))
            name, value = await self._x402_payment_header(offer, x402, withheld)
        else:
            name, value = self._mpp_credential(offer)
        retry.headers[name] = value
        retry.headers["Access-Control-Expose-Headers"] = "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE,Payment-Receipt"

        second, _, _ = await self._send(retry, follow=False)
        location = second.headers.get("location") if second.status_code in REDIRECT_STATUSES else None
        if location:
            # The seller redirects after paying (say, to the content with a token); the receipt is on this
            # response. Unlike the paid retry, this hop follows fetch's rules: 303 becomes a GET (HEAD stays
            # HEAD), a 301/302 POST becomes a GET, other methods are kept, and 307/308 repeat method and
            # body. Never a payment header.
            next_url = retry.url.join(location)
            if not _same_origin(next_url, retry.url):
                for n in ("authorization", "cookie"):
                    unpaid.pop(n, None)
            method = retry.method
            to_get = (second.status_code == 303 and method not in ("GET", "HEAD")) or (
                second.status_code in (301, 302) and method == "POST"
            )
            has_body = not to_get and method not in ("GET", "HEAD")
            if to_get:
                for n in _BODY_HEADERS:
                    unpaid.pop(n, None)
                unpaid.pop("content-length", None)
            unpaid.pop("host", None)
            followed, _, _ = await self._send(
                _Prepared("GET" if to_get else method, next_url, unpaid, retry.body if has_body else None), follow=True
            )
            headers = httpx.Headers(followed.headers)
            for n in ("payment-response", "x-payment-response", MPP_RECEIPT_HEADER):
                v = second.headers.get(n)
                if v:
                    headers[n] = v
            headers.pop("content-encoding", None)  # httpx decoded the body already
            headers.pop("content-length", None)
            result = httpx.Response(
                followed.status_code, headers=headers, content=followed.content, request=followed.request
            )
            return await self._settled(second, result, offer)
        if second.status_code == 402:
            # `details.response` is the server's answer; the reason comes from x402's PAYMENT-REQUIRED
            # header, or MPP's problem body.
            challenge: dict[str, Any] | None = None
            error: str | None = None
            try:
                if isinstance(offer, X402Offer):
                    decoded = decode_header_json(second.headers.get("payment-required") or "")
                    if isinstance(decoded, dict):
                        challenge = decoded
                        error = decoded.get("error") if isinstance(decoded.get("error"), str) else None
                else:
                    problem = second.json()
                    if isinstance(problem, dict) and isinstance(problem.get("detail"), str):
                        error = problem["detail"]
            except Exception:
                pass  # no decodable reason
            details = PaymentRejectedDetails(response=second, error=error, challenge=challenge)
            raise RadiusPaymentError(
                "payment_rejected", f"Server rejected the payment ({error or 'no reason given'})", details
            )
        return await self._settled(second, second, offer)

    async def _settled(self, paid: httpx.Response, result: httpx.Response, offer: PaymentOffer) -> httpx.Response:
        """Report the receipt carried by ``paid`` (the response to the paid request) and return ``result``."""
        receipt = self._x402_receipt(paid, offer) if isinstance(offer, X402Offer) else self._mpp_receipt(paid, offer)
        if receipt is not None and self._on_paid is not None:
            try:
                await _maybe_await(self._on_paid(receipt, offer))
            except Exception:
                logger.exception("radius-sdk on_paid hook failed")
        return result

    def _x402_receipt(self, res: httpx.Response, offer: X402Offer) -> PaymentReceipt | None:
        header = res.headers.get("payment-response") or res.headers.get("x-payment-response")
        return self._decode_receipt(header, offer) if header else None

    def _decode_receipt(self, header: str, offer: X402Offer) -> PaymentReceipt | None:
        """Decode the settlement receipt. For ``upto`` the reported amount is untrusted input (``invalid_receipt``)."""
        try:
            receipt = decode_payment_receipt(header, offer.network)
        except Exception as e:
            if offer.scheme == "upto":
                raise RadiusPaymentError("invalid_receipt", f"Invalid upto payment response: {e}", e) from e
            return None
        if offer.scheme == "upto" and receipt.amount is not None:
            try:
                parse_upto_settlement_amount(receipt.amount, int(offer.amount))
            except ValueError as e:
                raise RadiusPaymentError("invalid_receipt", f"Invalid upto payment response: {e}", receipt) from e
        # `exact` settles the offered amount; `upto` facilitators report what they charged (else assume the maximum).
        if receipt.success and receipt.amount is None:
            receipt.amount = offer.amount
        return receipt

    def _mpp_receipt(self, res: httpx.Response, offer: MppOffer) -> PaymentReceipt | None:
        """``Payment-Receipt`` completed with what the payer knows: itself, and the amount (a charge settles exactly that)."""
        header = res.headers.get(MPP_RECEIPT_HEADER)
        if not header:
            return None
        try:
            receipt = decode_mpp_receipt(header, offer.network)
        except Exception:
            return None
        receipt.payer = to_checksum_address(self.address)
        receipt.amount = offer.amount
        return receipt

    # -- offer selection ------------------------------------------------------------------------

    async def _read_challenge(self, res: httpx.Response) -> dict[str, Any]:
        """v2: ``PAYMENT-REQUIRED`` header (or, off-spec but seen in the wild, a JSON body); v1: JSON body."""
        text: str | None = None
        try:
            header = res.headers.get("payment-required")
            if header:
                decoded = decode_header_json(header)
                if not isinstance(decoded, dict):
                    raise ValueError("PAYMENT-REQUIRED is not an object")
                return decoded
            text = res.text
            body = json.loads(text) if text else None
            if isinstance(body, dict) and body.get("x402Version") in (1, 2):
                return body
            raise ValueError("no PAYMENT-REQUIRED header and no x402 challenge in the body")
        except Exception as e:
            raise RadiusPaymentError(
                "invalid_challenge",
                f"Could not parse the 402 challenge: {e}",
                InvalidChallengeDetails(response=res, body=text, cause=e),
            ) from e

    async def _select_offer(
        self, first: httpx.Response, request: _Prepared
    ) -> tuple[PaymentOffer, dict[str, Any] | None]:
        """Candidates across protocols in preference order, then :meth:`_pick_candidate`."""
        mpp_challenges = (
            parse_mpp_challenges(", ".join(first.headers.get_list("www-authenticate")))
            if "mpp" in self.protocols
            else []
        )
        x402: dict[str, Any] | None = None
        x402_error: Exception | None = None
        if "x402" in self.protocols:
            try:
                x402 = await self._read_challenge(first)
            except RadiusPaymentError as e:
                x402_error = e
        candidates: list[_Candidate] = []
        errors: list[RadiusPaymentError] = []
        for protocol in self.protocols:
            try:
                if protocol == "x402" and x402 is not None:
                    candidates.extend(self._x402_candidates(x402, str(request.url)))
                if protocol == "mpp" and mpp_challenges:
                    candidates.extend(self._mpp_candidates(mpp_challenges, request))
            except RadiusPaymentError as e:
                errors.append(e)
        if candidates:
            return await self._pick_candidate(candidates), x402
        if errors:
            raise errors[0]
        if x402_error is not None:
            raise x402_error
        raise RadiusPaymentError(
            "invalid_challenge",
            f"The 402 carries no {' or '.join(self.protocols)} challenge",
            InvalidChallengeDetails(response=first),
        )

    def _amount_of(self, version: int, req: dict[str, Any]) -> int:
        field_name = "maxAmountRequired" if version == 1 else "amount"
        raw = req.get(field_name)
        if not isinstance(raw, str) or not _ATOMIC.match(raw):
            raise RadiusPaymentError(
                "invalid_challenge", f"Offer {field_name} must be a non-negative integer string (got {_js(raw)})", req
            )
        return int(raw)

    def _x402_candidates(self, pr: dict[str, Any], request_url: str) -> list[_Candidate]:
        """The offers of an x402 challenge this client could pay, best first (networks in the client's order, server order within each)."""
        version = pr.get("x402Version")
        if version not in (1, 2) or isinstance(version, bool):
            raise RadiusPaymentError("invalid_challenge", f"Unsupported x402 version {version}")
        accepts = pr.get("accepts")
        if not isinstance(accepts, list) or not accepts:
            raise RadiusPaymentError("invalid_challenge", "Challenge has no accepts[]")
        accepts = [a for a in accepts if isinstance(a, dict)]
        on_network = [
            (rail, req)
            for rail in self._rails
            for req in accepts
            if isinstance(req.get("network"), str) and is_network_id(rail.network, req["network"])
        ]
        if not on_network:
            offered = ", ".join(dict.fromkeys(str(a.get("network")) for a in accepts)) or "none"
            raise RadiusPaymentError(
                "network_mismatch",
                f"Server accepts {offered}; this client pays on {self._describe_networks()}",
                accepts,
            )
        same_asset = [
            (rail, req)
            for rail, req in on_network
            if isinstance(req.get("asset"), str) and req["asset"].lower() == rail.network.asset.address.lower()
        ]
        if not same_asset:
            raise RadiusPaymentError(
                "asset_mismatch", f"Server does not accept {self._describe_assets()}", [r for _, r in on_network]
            )
        # `exact` exists in v1 and v2; `upto` is a v2 scheme only.
        known = [
            (rail, req)
            for rail, req in same_asset
            if req.get("scheme") == "exact" or (req.get("scheme") == "upto" and version == 2)
        ]
        if not known:
            schemes = ", ".join(dict.fromkeys(f"{req.get('scheme')}@v{version}" for _, req in same_asset))
            raise RadiusPaymentError(
                "no_compatible_offer",
                f"Server offers {schemes}; this client supports {describe_supported_schemes()}",
                [r for _, r in same_asset],
            )

        # v1 `exact` is always EIP-3009 and `upto` always Permit2; v2 `exact` names its transfer method
        # (none means EIP-3009, the x402 default).
        def method_ok(req: dict[str, Any]) -> bool:
            if version == 1 or req.get("scheme") == "upto":
                return True
            m = (req.get("extra") or {}).get("assetTransferMethod")
            return m is None or m in ("permit2", "eip3009")

        supported = [(rail, req) for rail, req in known if method_ok(req)]
        if not supported:
            methods = ", ".join(
                dict.fromkeys(str((req.get("extra") or {}).get("assetTransferMethod")) for _, req in known)
            )
            raise RadiusPaymentError(
                "unsupported_transfer_method",
                f"Server requires assetTransferMethod {methods}; this client supports permit2 and eip3009",
                [r for _, r in known],
            )
        # Offers within the cap. Amounts are not compared across schemes or networks: an `upto` amount is a ceiling, not a price.
        priced = [(rail, req, self._amount_of(version, req)) for rail, req in supported]
        affordable = [p for p in priced if p[2] <= p[0].cap]
        if not affordable:
            rail, first, first_amount = priced[0]
            asset = rail.network.asset
            offered_text = format_amount(first_amount, asset.decimals, asset.symbol)
            limit = format_amount(rail.cap, asset.decimals, asset.symbol)
            message = (
                f"Offer authorises up to {offered_text}, exceeding maxPerRequest {limit}"
                if first.get("scheme") == "upto"
                else f"Offer {offered_text} exceeds maxPerRequest {limit}"
            )
            raise RadiusPaymentError("price_above_limit", message, [p[1] for p in priced])
        return [
            _Candidate(
                rail,
                amount,
                functools.partial(self._x402_offer, pr, request_url, req, amount, rail.network),
            )
            for rail, req, amount in affordable
        ]

    def _x402_offer(
        self, pr: dict[str, Any], request_url: str, req: dict[str, Any], amount: int, network: PaymentNetwork
    ) -> X402Offer:
        version = pr["x402Version"]
        scheme = req["scheme"]
        if not isinstance(req.get("payTo"), str) or not is_address(req["payTo"]):
            raise RadiusPaymentError(
                "invalid_challenge", f"Offer payTo is not an address (got {_js(req.get('payTo'))})", req
            )
        extra = req.get("extra") or {}
        if scheme == "upto":
            facilitator = extra.get("facilitatorAddress", extra.get("facilitator"))
            if not isinstance(facilitator, str) or not is_address(facilitator):
                raise RadiusPaymentError(
                    "invalid_challenge",
                    "upto offer is missing a valid extra.facilitatorAddress; cannot bind the Permit2 witness",
                    req,
                )
        extensions = pr.get("extensions")
        gas_sponsored = isinstance(extensions, dict) and any(k in extensions for k in SPONSORING_KEYS)
        # v1 has no top-level resource; its accepts[] carry description/mimeType.
        resource_info = pr.get("resource") if version == 2 else None
        if isinstance(resource_info, dict) and isinstance(resource_info.get("url"), str):
            resource = Resource(resource_info["url"], resource_info.get("description"), resource_info.get("mimeType"))
        else:
            resource = Resource(request_url, req.get("description"), req.get("mimeType"))
        return X402Offer(
            x402_version=version,
            scheme=scheme,
            amount=str(amount),
            amount_formatted=format_amount(amount, network.asset.decimals, network.asset.symbol),
            asset=req["asset"],
            pay_to=req["payTo"],
            network=network,
            resource=resource,
            requirements=req,
            transfer_method="permit2"
            if scheme == "upto" or (version == 2 and extra.get("assetTransferMethod") == "permit2")
            else "eip3009",
            gas_sponsored=gas_sponsored,
        )

    def _for_signing(self, offer: X402Offer) -> dict[str, Any]:
        """The requirement handed to the x402 schemes for signing.

        Fills in what the schemes need but a server may omit: the asset's EIP-712 domain, a signing
        window, and the ``extra.facilitator`` alias radius-cli accepts for ``facilitatorAddress``. Only
        the signer sees this; the untouched requirement is what gets echoed back to the server.
        """
        req = offer.requirements
        extra: dict[str, Any] = {
            "name": offer.network.asset.name,
            "version": offer.network.asset.version,
            **(req.get("extra") or {}),
        }
        if extra.get("facilitatorAddress") is None and isinstance(extra.get("facilitator"), str):
            extra["facilitatorAddress"] = extra["facilitator"]
        t = req.get("maxTimeoutSeconds")
        timeout = (
            min(int(t), MAX_TIMEOUT_SECONDS)
            if isinstance(t, (int, float)) and not isinstance(t, bool) and t > 0
            else MAX_TIMEOUT_SECONDS
        )
        out = {**req, "maxTimeoutSeconds": timeout, "extra": extra}
        if offer.x402_version == 1 and not isinstance(out.get("resource"), str):
            out["resource"] = offer.resource.url
        return out

    async def _x402_payment_header(self, offer: X402Offer, pr: dict[str, Any], withheld: set[str]) -> tuple[str, str]:
        # Narrow the challenge to the chosen offer so the upstream selector cannot pick another, and hide
        # the sponsoring extensions that were not approved.
        narrowed: dict[str, Any] = {**pr, "accepts": [self._for_signing(offer)]}
        extensions = pr.get("extensions")
        if isinstance(extensions, dict) and withheld:
            narrowed["extensions"] = {k: v for k, v in extensions.items() if k not in withheld}
        rail = self._rail_for(offer.network)
        assert rail is not None
        rail.scheme_signer.loop = asyncio.get_running_loop()
        try:
            if offer.x402_version == 1:
                model: Any = PaymentRequiredV1.model_validate(narrowed)
            else:
                model = PaymentRequired.model_validate(narrowed)
            payload = await asyncio.to_thread(self.client.create_payment_payload, model)
        except RadiusPaymentError:
            raise
        except Exception as e:
            raise RadiusPaymentError("invalid_challenge", f"Could not sign the payment: {e}", offer) from e
        wire = payload.model_dump(by_alias=True, exclude_none=True)
        if offer.x402_version == 2:
            # v2 servers match `accepted` against the requirement they sent (core fields equal, their
            # `extra` a subset of ours), so echo it untouched rather than the filled-in signing copy.
            wire["accepted"] = offer.requirements
        encoded = base64.b64encode(json.dumps(wire, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).decode(
            "ascii"
        )
        return ("PAYMENT-SIGNATURE" if offer.x402_version == 2 else "X-PAYMENT"), encoded

    async def _ensure_allowance(self, offer: X402Offer, extensions: Any) -> set[str]:
        """Permit2 needs an ERC-20 allowance; returns the extension keys to withhold from the scheme.

        Unsponsored: approve on-chain once. Sponsored: the scheme signs either an EIP-2612 permit (per
        payment, for the payment amount: part of the payment, not gated) or a raw approve transaction
        that the facilitator submits; the latter is an allowance change, so it passes the same gate
        (``permit2_approval``, ``on_approval_required``). The x402 scheme never signs a raw approve on its
        own (it re-reads the allowance and signs when that read fails).
        """
        withheld: set[str] = set()

        def has(k: str) -> bool:
            return isinstance(extensions, dict) and k in extensions

        if offer.transfer_method != "permit2":
            return withheld
        rail = self._rail_for(offer.network)
        assert rail is not None
        wallet = self._wallets[id(rail)]
        # The permit is preferred over the raw approve, so the latter is only reachable without it.
        raw_approve = has("erc20ApprovalGasSponsoring") and not has("eip2612GasSponsoring")
        if has("erc20ApprovalGasSponsoring") and not raw_approve:
            withheld.add("erc20ApprovalGasSponsoring")
        if offer.gas_sponsored and not raw_approve:
            return withheld
        # A failed read counts as no allowance: decide explicitly rather than let the scheme sign blindly.
        if offer.gas_sponsored:
            try:
                current = await wallet.permit2_allowance()
            except Exception:
                current = 0
        else:
            current = await wallet.permit2_allowance()
        if current >= int(offer.amount):
            if raw_approve:
                withheld.add("erc20ApprovalGasSponsoring")
            return withheld
        never = self._permit2_approval == "never"
        asset = offer.network.asset.address
        if offer.gas_sponsored:
            request = ApprovalRequest(
                "payment", offer.network, asset, PERMIT2_ADDRESS, MAX_UINT256, current, offer, "erc20Approval"
            )
            if never:
                raise RadiusPaymentError(
                    "approval_required",
                    f"Permit2 allowance {current} is below {offer.amount}; the facilitator sponsors an approval but permit2_approval is 'never'",
                    request,
                )
            await self._authorize_approval(request)
            return withheld
        request = ApprovalRequest("payment", offer.network, asset, PERMIT2_ADDRESS, MAX_UINT256, current, offer)
        if never:
            raise RadiusPaymentError(
                "approval_required",
                f"Permit2 allowance {current} is below {offer.amount} and the facilitator does not sponsor approvals; call approve_permit2() or set permit2_approval='auto'",
                request,
            )
        await wallet._send_approval(request, "Permit2 approval")
        return withheld

    def _mpp_candidates(self, challenges: list[MppChallenge], request: _Prepared) -> list[_Candidate]:
        """The payable MPP challenges, best first.

        Only ``evm`` charges in the network's asset, authorizable by EIP-3009, are payable. The
        credential only ever goes in ``Authorization``: a challenge naming another header is skipped,
        and so is every challenge when the request already carries its own ``Authorization``.
        """
        usable = [
            c
            for c in challenges
            if (c.header is None or c.header.lower() == "authorization") and "authorization" not in request.headers
        ]
        charges = [c for c in usable if c.method == MPP_METHOD and c.intent == MPP_INTENT]
        if not charges:
            offered = ", ".join(dict.fromkeys(f"{c.method}/{c.intent}" for c in challenges))
            why = (
                " (challenges are skipped when the request already sets Authorization, or name another credential header)"
                if len(usable) < len(challenges)
                else ""
            )
            raise RadiusPaymentError(
                "no_compatible_offer", f"Server offers MPP {offered}; this client pays MPP evm/charge{why}", challenges
            )

        def details(c: MppChallenge) -> dict[str, Any]:
            d = c.request.get("methodDetails")
            return d if isinstance(d, dict) else {}

        on_network = [
            (rail, c)
            for rail in self._rails
            for c in charges
            if details(c).get("chainId") == rail.network.chain_id and not isinstance(details(c).get("chainId"), bool)
        ]
        if not on_network:
            offered = ", ".join(dict.fromkeys(f"eip155:{details(c).get('chainId')}" for c in charges))
            raise RadiusPaymentError(
                "network_mismatch",
                f"Server accepts {offered}; this client pays on {self._describe_networks()}",
                charges,
            )
        same_asset = [
            (rail, c)
            for rail, c in on_network
            if isinstance(c.request.get("currency"), str)
            and c.request["currency"].lower() == rail.network.asset.address.lower()
        ]
        if not same_asset:
            raise RadiusPaymentError(
                "asset_mismatch", f"Server does not accept {self._describe_assets()}", [c for _, c in on_network]
            )

        def payable_ok(c: MppChallenge) -> bool:
            d = details(c)
            types, splits = d.get("credentialTypes"), d.get("splits")
            return (
                isinstance(types, list)
                and "authorization" in types
                and not (isinstance(splits, list) and len(splits) > 0)
            )

        payable = [(rail, c) for rail, c in same_asset if payable_ok(c)]
        if not payable:
            raise RadiusPaymentError(
                "unsupported_transfer_method",
                "Server requires an MPP evm credential other than an EIP-3009 authorization, or payment splits",
                [c for _, c in same_asset],
            )
        priced = []
        for rail, c in payable:
            raw = c.request.get("amount")
            if not isinstance(raw, str) or not _ATOMIC.match(raw):
                raise RadiusPaymentError(
                    "invalid_challenge", f"MPP request amount must be a non-negative integer string (got {_js(raw)})", c
                )
            priced.append((rail, c, int(raw)))
        affordable = [p for p in priced if p[2] <= p[0].cap]
        if not affordable:
            rail, _, amount = priced[0]
            asset = rail.network.asset
            raise RadiusPaymentError(
                "price_above_limit",
                f"Offer {format_amount(amount, asset.decimals, asset.symbol)} exceeds maxPerRequest {format_amount(rail.cap, asset.decimals, asset.symbol)}",
                [p[1] for p in priced],
            )
        return [
            _Candidate(rail, amount, functools.partial(self._mpp_offer, c, amount, rail.network, request))
            for rail, c, amount in affordable
        ]

    def _mpp_offer(self, c: MppChallenge, amount: int, network: PaymentNetwork, request: _Prepared) -> MppOffer:
        recipient = c.request.get("recipient")
        if not isinstance(recipient, str) or not is_address(recipient):
            raise RadiusPaymentError(
                "invalid_challenge", f"MPP request recipient is not an address (got {_js(recipient)})", c
            )
        return MppOffer(
            amount=str(amount),
            amount_formatted=format_amount(amount, network.asset.decimals, network.asset.symbol),
            asset=c.request["currency"],
            pay_to=recipient,
            network=network,
            resource=Resource(str(request.url), c.description),
            challenge=c,
        )

    def _mpp_credential(self, offer: MppOffer) -> tuple[str, str]:
        """An EIP-3009 ``transferWithAuthorization`` to the recipient, its nonce bound to the challenge, valid until it expires (capped)."""
        c = offer.challenge
        asset, chain_id = offer.network.asset, offer.network.chain_id
        now = int(time.time())
        expires = _parse_iso_seconds(c.expires) if c.expires is not None else None
        valid_before = min(expires, now + MAX_TIMEOUT_SECONDS) if expires is not None else now + 300
        if valid_before <= now:
            raise RadiusPaymentError("invalid_challenge", f"MPP challenge expired at {c.expires}", c)
        frm = to_checksum_address(self.address)
        to = to_checksum_address(offer.pay_to)
        nonce = mpp_challenge_nonce(c)
        signature = sign_typed_data(
            self._signer,
            {"name": asset.name, "version": asset.version, "chainId": chain_id, "verifyingContract": asset.address},
            AUTHORIZATION_TYPES,
            "TransferWithAuthorization",
            {
                "from": frm,
                "to": to,
                "value": int(offer.amount),
                "validAfter": 0,
                "validBefore": valid_before,
                "nonce": nonce,
            },
        )
        payload = {
            "type": "authorization",
            "from": frm,
            "to": to,
            "value": offer.amount,
            "validAfter": "0",
            "validBefore": str(valid_before),
            "nonce": nonce,
            "signature": signature,
        }
        return "Authorization", serialize_mpp_credential(c, payload, mpp_source(chain_id, frm))

    async def _pick_candidate(self, candidates: list[_Candidate]) -> PaymentOffer:
        """The candidate to pay. With ``prefer_funded`` and candidates on several networks, the first one the payer's balance covers wins."""
        rails = list({id(c.rail): c.rail for c in candidates}.values())
        if not self._prefer_funded or len(rails) < 2:
            return candidates[0].build()
        reads = await asyncio.gather(*(self._wallets[id(r)].balance() for r in rails), return_exceptions=True)
        balance_of: dict[int, int | None] = {
            id(r): (None if isinstance(v, BaseException) else v[0]) for r, v in zip(rails, reads, strict=True)
        }

        def covers(c: _Candidate) -> bool:
            have = balance_of[id(c.rail)]
            return have is not None and have >= c.amount

        funded = next((c for c in candidates if covers(c)), None)
        unknown = next((c for c in candidates if balance_of[id(c.rail)] is None), None)
        chosen = funded or unknown
        if chosen is not None:
            return chosen.build()
        shortfalls = []
        texts = []
        for r in rails:
            need = next(c.amount for c in candidates if c.rail is r)
            have = balance_of[id(r)] or 0
            a = r.network.asset
            texts.append(
                f"{format_amount(need, a.decimals, a.symbol)} on {r.network.name} (have {format_amount(have, a.decimals, a.symbol)})"
            )
            shortfalls.append({"network": r.network, "need": need, "have": have})
        raise RadiusPaymentError("insufficient_balance", f"Insufficient balance: need {' or '.join(texts)}", shortfalls)


AUTHORIZATION_TYPES: dict[str, list[dict[str, str]]] = {
    "TransferWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ]
}


def _parse_iso_seconds(value: str) -> int | None:
    try:
        text = value.strip()
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except ValueError:
        return None


def _js(value: Any) -> str:
    """``JSON.stringify`` for error messages (``undefined`` for a missing value)."""
    if value is None:
        return "undefined"
    try:
        return json.dumps(value)
    except TypeError:
        return repr(value)


def create_radius_fetch(**options: Any) -> RadiusFetch:
    """Create a client that pays x402 and MPP challenges automatically, within a per-request ceiling.

    Options (keyword-only), matching the TypeScript ``createRadiusFetch``:

    - ``signer`` (required): a private key, an eth-account ``LocalAccount``, or any object with
      ``address`` and ``sign_typed_data(domain, types, primary_type, message) -> bytes``.
    - ``max_per_request`` (required): hard ceiling per request, e.g. ``"$0.05"`` or ``{"amount": "50000"}``.
      NOT a cumulative budget.
    - ``network`` / ``networks``: where to pay ('mainnet' default, 'testnet', 'base', 'base-sepolia', or a
      ``PaymentNetwork``); several in preference order.
    - ``protocols``: ``("x402", "mpp")`` by default, in preference order.
    - ``prefer_funded`` (default True), ``on_payment_required``, ``permit2_approval`` ('auto' | 'never'),
      ``on_approval_required``, ``on_paid``.
    - ``http_client``: the ``httpx.AsyncClient`` for seller requests; ``rpc_http_client`` for JSON-RPC.
    - Network overrides for the first network: ``rpc_url``, ``facilitator_url``, ``explorer_url``,
      ``faucet_url``, ``asset``.
    """
    return RadiusFetch(**options)


__all__ = [
    "AUTHORIZATION_TYPES",
    "ApprovalRequest",
    "FaucetResult",
    "InvalidChallengeDetails",
    "MppOffer",
    "NetworkWallet",
    "PaymentOffer",
    "PaymentProtocol",
    "PaymentReceipt",
    "PaymentRejectedDetails",
    "PaymentScheme",
    "RadiusFetch",
    "RadiusPaymentError",
    "Resource",
    "X402Offer",
    "create_radius_fetch",
    "get_payment_receipt",
    "get_settlement",
]
