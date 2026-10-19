"""A small async JSON-RPC client for EVM nodes, and a wallet client that signs and sends transactions.

This plays the part viem's public and wallet clients play in the TypeScript SDK: the balance,
ERC-20, Permit2 and settlement actions take a :class:`RpcClient` (reads) or a :class:`WalletClient`
(writes) as their first argument. It speaks plain JSON-RPC over ``httpx``, so tests can hand it an
``httpx.AsyncClient`` with a mock transport.

ABI encoding needs ``eth-abi`` and signing needs ``eth-account`` (``pip install radius-sdk[client]``).
"""

from __future__ import annotations

import asyncio
import itertools
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import httpx
from eth_utils import keccak, to_checksum_address

from .errors import RadiusPaymentError
from .networks import Chain, PaymentNetwork

BlockParam = int | str
"""A block number, or a tag such as ``"latest"``."""


class RpcError(Exception):
    """A JSON-RPC error object returned by the node."""

    def __init__(self, code: int | None, message: str, data: Any = None) -> None:
        super().__init__(f"{message} (code {code})" if code is not None else message)
        self.code = code
        self.message = message
        self.data = data


def to_hex(value: int) -> str:
    return hex(value)


def block_param(block_number: int | None = None, block_tag: str | None = None) -> str:
    return hex(block_number) if block_number is not None else (block_tag or "latest")


@dataclass(frozen=True)
class AbiFunction:
    """A contract function by signature, e.g. ``AbiFunction("balanceOf", ("address",), ("uint256",))``."""

    name: str
    inputs: tuple[str, ...] = ()
    outputs: tuple[str, ...] = ()

    @property
    def signature(self) -> str:
        return f"{self.name}({','.join(self.inputs)})"

    @property
    def selector(self) -> bytes:
        return keccak(text=self.signature)[:4]

    def encode(self, *args: Any) -> str:
        from eth_abi import encode

        return "0x" + (self.selector + encode(list(self.inputs), list(args))).hex()

    def decode(self, data: str) -> Any:
        from eth_abi import decode

        raw = bytes.fromhex(data[2:] if data.startswith("0x") else data)
        values = decode(list(self.outputs), raw)
        return values[0] if len(values) == 1 else tuple(values)


class RpcClient:
    """Async JSON-RPC client for one chain.

    ``chain`` (optional) names the chain the node serves, as viem's client ``chain`` does: actions
    use it for EIP-712 domains, default tokens and explorer links.
    """

    def __init__(
        self,
        url: str,
        *,
        chain: Chain | None = None,
        http_client: httpx.AsyncClient | None = None,
        timeout: float = 30.0,
        polling_interval: float = 1.0,
    ) -> None:
        self.url = url
        self.chain = chain
        self.polling_interval = polling_interval
        self._http = http_client
        self._owns_http = http_client is None
        self._timeout = timeout
        self._ids = itertools.count(1)

    @classmethod
    def for_network(cls, network: PaymentNetwork, **kwargs: Any) -> RpcClient:
        return cls(network.rpc_url, chain=network.chain, **kwargs)

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=self._timeout)
        return self._http

    async def aclose(self) -> None:
        if self._owns_http and self._http is not None:
            await self._http.aclose()
            self._http = None

    async def __aenter__(self) -> RpcClient:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def request(self, method: str, params: Sequence[Any] | None = None) -> Any:
        body = {"jsonrpc": "2.0", "id": next(self._ids), "method": method, "params": list(params or [])}
        res = await self._client().post(self.url, json=body)
        try:
            payload = res.json()
        except ValueError as e:
            raise RpcError(None, f"{method}: HTTP {res.status_code} with a non-JSON body") from e
        if isinstance(payload, dict) and payload.get("error"):
            err = payload["error"]
            raise RpcError(err.get("code"), str(err.get("message", "RPC error")), err.get("data"))
        if res.status_code >= 400 or not isinstance(payload, dict) or "result" not in payload:
            raise RpcError(None, f"{method}: HTTP {res.status_code} without a JSON-RPC result")
        return payload["result"]

    # -- reads ------------------------------------------------------------------------------

    async def chain_id(self) -> int:
        if self.chain is not None:
            return self.chain.id
        return int(await self.request("eth_chainId"), 16)

    async def block_number(self) -> int:
        return int(await self.request("eth_blockNumber"), 16)

    async def get_balance(self, address: str, block: BlockParam = "latest") -> int:
        return int(await self.request("eth_getBalance", [address, _block(block)]), 16)

    async def call(self, to: str | None, data: str, block: BlockParam = "latest") -> str:
        tx: dict[str, Any] = {"data": data}
        if to is not None:
            tx["to"] = to
        return await self.request("eth_call", [tx, _block(block)])

    async def read_contract(self, address: str, fn: AbiFunction, *args: Any, block: BlockParam = "latest") -> Any:
        return fn.decode(await self.call(address, fn.encode(*args), block))

    async def get_transaction_receipt(self, tx_hash: str) -> dict[str, Any] | None:
        return await self.request("eth_getTransactionReceipt", [tx_hash])

    async def wait_for_transaction_receipt(self, tx_hash: str, *, timeout: float = 120.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            receipt = await self.get_transaction_receipt(tx_hash)
            if receipt is not None:
                return receipt
            if time.monotonic() > deadline:
                raise TimeoutError(f"Timed out waiting for the receipt of {tx_hash}")
            await asyncio.sleep(min(self.polling_interval, 0.25))

    async def get_logs(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        return await self.request("eth_getLogs", [params])


class WalletClient(RpcClient):
    """An :class:`RpcClient` with an account that signs and sends transactions (viem's wallet client).

    ``account`` is an eth-account ``LocalAccount`` (``Account.from_key(...)``) or a private key.
    """

    def __init__(self, url: str, account: Any, **kwargs: Any) -> None:
        super().__init__(url, **kwargs)
        self.account = to_local_account(account)

    @classmethod
    def for_network(cls, network: PaymentNetwork, account: Any = None, **kwargs: Any) -> WalletClient:  # type: ignore[override]
        return cls(network.rpc_url, account, chain=network.chain, **kwargs)

    @property
    def address(self) -> str:
        return self.account.address

    async def send_transaction(self, *, to: str, data: str = "0x", value: int = 0, gas: int | None = None) -> str:
        """Sign and send a transaction from the account; returns its hash.

        Fees follow viem's defaults: EIP-1559 when the latest block has a base fee (``1.2 × baseFee +
        priority``), else a legacy ``eth_gasPrice`` transaction. Without ``gas`` the limit comes from
        ``eth_estimateGas``, the only pre-send revert check.
        """
        frm = self.account.address
        chain_id, nonce, block = await asyncio.gather(
            self.chain_id(),
            self.request("eth_getTransactionCount", [frm, "pending"]),
            self.request("eth_getBlockByNumber", ["latest", False]),
        )
        tx: dict[str, Any] = {
            "chainId": chain_id,
            "nonce": int(nonce, 16),
            "to": to_checksum_address(to),
            "value": value,
            "data": data,
        }
        if gas is None:
            gas = int(
                await self.request("eth_estimateGas", [{"from": frm, "to": to, "data": data, "value": hex(value)}]), 16
            )
        tx["gas"] = gas
        base_fee = block.get("baseFeePerGas") if isinstance(block, dict) else None
        if base_fee is not None:
            try:
                priority = int(await self.request("eth_maxPriorityFeePerGas"), 16)
            except RpcError:
                priority = 1_500_000_000
            tx["maxPriorityFeePerGas"] = priority
            tx["maxFeePerGas"] = int(base_fee, 16) * 12 // 10 + priority
            tx["type"] = 2
        else:
            tx["gasPrice"] = int(await self.request("eth_gasPrice"), 16)
        signed = self.account.sign_transaction(tx)
        raw = signed.raw_transaction if hasattr(signed, "raw_transaction") else signed.rawTransaction
        return await self.request("eth_sendRawTransaction", ["0x" + bytes(raw).hex()])

    async def write_contract(self, address: str, fn: AbiFunction, *args: Any, gas: int | None = None) -> str:
        return await self.send_transaction(to=address, data=fn.encode(*args), gas=gas)


def to_local_account(account: Any) -> Any:
    """An eth-account ``LocalAccount`` from a private key, or the account itself."""
    if isinstance(account, str):
        try:
            from eth_account import Account
        except ImportError as e:  # pragma: no cover
            raise ImportError("Signing needs eth-account: pip install 'radius-sdk[client]'") from e
        return Account.from_key(account)
    if account is None or not hasattr(account, "address") or not hasattr(account, "sign_transaction"):
        raise RadiusPaymentError(
            "config",
            "A wallet client needs an account that signs transactions (a private key or eth-account LocalAccount)",
        )
    return account


def _block(block: BlockParam) -> str:
    return hex(block) if isinstance(block, int) else block
