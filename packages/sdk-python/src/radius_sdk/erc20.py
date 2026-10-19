"""Common ERC-20 interactions: metadata, allowance, approve, transfer, transferFrom, and Transfer events.

On the preset networks the default token is the network's payment asset (SBC on Radius, USDC on
Base); on any other chain pass ``token``, or bind one with ``Erc20Actions(client, network=...)``.

Reads take an :class:`~radius_sdk.rpc.RpcClient`; writes take a :class:`~radius_sdk.rpc.WalletClient`
and wait for the receipt (Radius finality is sub-second). Amounts are ``int`` atomic units or a
decimal string in display units, parsed with the token's ``decimals`` (read on-chain when the token
is given as a bare address).

Transfer events. Radius block numbers are unix milliseconds and a node answers ``eth_getLogs`` only
for spans of at most :data:`MAX_LOG_RANGE` (1e6 blocks, about 16.7 minutes), so
:func:`get_transfers` defaults to that window before ``to_block`` and fetches wider ranges in
sequential chunks. :func:`watch_transfers` is the SDK's own poller (the node has no
``eth_newFilter``): ordered, at-least-once delivery from a resumable ``from_block``, with
``on_checkpoint`` after every fully delivered range. Dedupe on :func:`transfer_key` when resuming.
"""

from __future__ import annotations

import asyncio
import inspect
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal, Union

from eth_utils import keccak, to_checksum_address

from .balances import BalanceToken, format_units
from .errors import RadiusPaymentError
from .networks import NetworkInput, PaymentAsset, preset_for_chain_id, resolve_network
from .rpc import AbiFunction, RpcClient, WalletClient

TokenInput = Union[str, BalanceToken, PaymentAsset]
"""A token by address, or with its decimals/symbol known up front (saves the ``decimals()`` read)."""
TokenAmount = Union[int, str]
"""``int`` = atomic units; ``str`` = display units (e.g. "1.5"), parsed with the token's decimals."""

#: Widest ``to_block - from_block`` a Radius node accepts for ``eth_getLogs`` (error -33002 beyond).
MAX_LOG_RANGE = 1_000_000
#: Most ``eth_getLogs`` calls one :func:`get_transfers` makes before refusing; page wider ranges yourself.
MAX_LOG_CHUNKS = 1_000

NAME = AbiFunction("name", (), ("string",))
SYMBOL = AbiFunction("symbol", (), ("string",))
DECIMALS = AbiFunction("decimals", (), ("uint8",))
TOTAL_SUPPLY = AbiFunction("totalSupply", (), ("uint256",))
ALLOWANCE = AbiFunction("allowance", ("address", "address"), ("uint256",))
APPROVE = AbiFunction("approve", ("address", "uint256"), ("bool",))
TRANSFER = AbiFunction("transfer", ("address", "uint256"), ("bool",))
TRANSFER_FROM = AbiFunction("transferFrom", ("address", "address", "uint256"), ("bool",))
TRANSFER_TOPIC = "0x" + keccak(text="Transfer(address,address,uint256)").hex()


@dataclass(frozen=True)
class TokenMetadata:
    address: str
    name: str
    symbol: str
    decimals: int
    total_supply: int


@dataclass(frozen=True)
class TxResult:
    hash: str
    #: ``pending``: sent but not waited for (``wait=False``); ``success`` / ``reverted``: from the receipt.
    status: Literal["pending", "success", "reverted"]
    explorer_url: str | None = None


@dataclass(frozen=True)
class TokenTransfer:
    token: str
    from_: str
    to: str
    #: Atomic units.
    amount: int
    transaction_hash: str
    block_number: int
    log_index: int


def _address_of(token: TokenInput) -> str:
    return token if isinstance(token, str) else token.address


def resolve_token(client: RpcClient, token: TokenInput | None, what: str) -> TokenInput:
    """The token an action works on: the argument, else the payment asset of the client's preset chain."""
    if token:
        return token
    preset = preset_for_chain_id(client.chain.id if client.chain else None)
    if preset:
        return preset.asset
    chain = f"chain {client.chain.id}" if client.chain else "a client with no chain"
    raise RadiusPaymentError(
        "config",
        f"{what}: no token given and {chain} is not a preset network, so there is no default token. "
        "Pass token=..., or bind one with Erc20Actions(client, network=...) or Erc20Actions(client, token=network.asset).",
    )


def configured_token(
    client: RpcClient, token: TokenInput | None, network: NetworkInput | None, what: str
) -> TokenInput | None:
    """Default token from an actions config: ``token``, else ``network``'s payment asset (checked against the client's chain)."""
    if token:
        return token
    if network is None:
        return None
    net = resolve_network(network)
    if client.chain and client.chain.id != net.chain_id:
        raise RadiusPaymentError(
            "config", f"{what}: network {net.name} is chain {net.chain_id} but the client is on chain {client.chain.id}"
        )
    return net.asset


async def _decimals_of(client: RpcClient, token: TokenInput) -> int:
    if not isinstance(token, str):
        return token.decimals
    return int(await client.read_contract(token, DECIMALS))


_DISPLAY = re.compile(r"^[0-9]+(\.[0-9]+)?\Z")


async def to_token_atomic(client: RpcClient, token: TokenInput, amount: TokenAmount) -> int:
    """Convert a :data:`TokenAmount` to atomic units, reading ``decimals()`` only when needed."""
    if isinstance(amount, int) and not isinstance(amount, bool):
        if amount < 0:
            raise RadiusPaymentError("config", f"Token amount must not be negative (got {amount})")
        return amount
    if not isinstance(amount, str):
        raise RadiusPaymentError(
            "config", f"Token amount must be a decimal string or an int of atomic units (got {amount!r})"
        )
    s = amount.strip()
    if not _DISPLAY.match(s):
        raise RadiusPaymentError(
            "config", f'Token amount must be a decimal string like "1.5" or an int of atomic units (got {amount!r})'
        )
    decimals = await _decimals_of(client, token)
    whole, _, frac = s.partition(".")
    if len(frac) > decimals:
        raise RadiusPaymentError("config", f"Token amount {s} has more than {decimals} decimal places")
    return int(whole + frac.ljust(decimals, "0"))


async def get_token_metadata(client: RpcClient, token: TokenInput | None = None) -> TokenMetadata:
    """``name``, ``symbol``, ``decimals`` and ``totalSupply`` of a token, read concurrently."""
    address = _address_of(resolve_token(client, token, "get_token_metadata"))
    name, symbol, decimals, total_supply = await asyncio.gather(
        client.read_contract(address, NAME),
        client.read_contract(address, SYMBOL),
        client.read_contract(address, DECIMALS),
        client.read_contract(address, TOTAL_SUPPLY),
    )
    return TokenMetadata(address=address, name=name, symbol=symbol, decimals=int(decimals), total_supply=total_supply)


async def get_allowance(client: RpcClient, owner: str, spender: str, *, token: TokenInput | None = None) -> int:
    """ERC-20 ``allowance(owner, spender)``, in atomic units."""
    address = _address_of(resolve_token(client, token, "get_allowance"))
    return int(await client.read_contract(address, ALLOWANCE, owner, spender))


def require_account(client: Any, what: str) -> Any:
    """The client's account, else a ``config`` error naming the action."""
    account = getattr(client, "account", None)
    if account is None:
        raise RadiusPaymentError(
            "config", f"{what} needs a WalletClient with an account: WalletClient(url, account, chain=...)"
        )
    return account


def explorer_url_for(client: RpcClient, tx_hash: str) -> str | None:
    """Explorer link for a transaction on the client's chain, when it declares an explorer."""
    explorer = client.chain.block_explorer if client.chain else None
    return f"{explorer.url.rstrip('/')}/tx/{tx_hash}" if explorer else None


async def send_and_wait(client: RpcClient, wait: bool, send: Callable[[], Awaitable[str]]) -> TxResult:
    """Send through ``send``, then wait for the receipt. ``wait=False`` returns ``pending`` without the outcome."""
    tx_hash = await send()
    explorer_url = explorer_url_for(client, tx_hash)
    if not wait:
        return TxResult(tx_hash, "pending", explorer_url)
    receipt = await client.wait_for_transaction_receipt(tx_hash)
    return TxResult(tx_hash, "success" if _receipt_ok(receipt) else "reverted", explorer_url)


def _receipt_ok(receipt: dict[str, Any]) -> bool:
    status = receipt.get("status")
    return status in ("0x1", 1, "success")


def _wallet(client: Any, what: str) -> WalletClient:
    require_account(client, what)
    return client  # type: ignore[no-any-return]


async def approve(
    client: WalletClient,
    spender: str,
    amount: TokenAmount,
    *,
    token: TokenInput | None = None,
    wait: bool = True,
    gas: int | None = None,
) -> TxResult:
    """ERC-20 ``approve(spender, amount)`` from the client's account."""
    wallet = _wallet(client, "approve")
    t = resolve_token(client, token, "approve")
    atomic = await to_token_atomic(client, t, amount)
    return await send_and_wait(
        client, wait, lambda: wallet.write_contract(_address_of(t), APPROVE, spender, atomic, gas=gas)
    )


async def transfer(
    client: WalletClient,
    to: str,
    amount: TokenAmount,
    *,
    token: TokenInput | None = None,
    wait: bool = True,
    gas: int | None = None,
) -> TxResult:
    """ERC-20 ``transfer(to, amount)`` from the client's account."""
    wallet = _wallet(client, "transfer")
    t = resolve_token(client, token, "transfer")
    atomic = await to_token_atomic(client, t, amount)
    return await send_and_wait(
        client, wait, lambda: wallet.write_contract(_address_of(t), TRANSFER, to, atomic, gas=gas)
    )


async def transfer_from(
    client: WalletClient,
    from_: str,
    to: str,
    amount: TokenAmount,
    *,
    token: TokenInput | None = None,
    wait: bool = True,
    gas: int | None = None,
) -> TxResult:
    """ERC-20 ``transferFrom(from, to, amount)``: spend an allowance ``from_`` granted to the client's account."""
    wallet = _wallet(client, "transfer_from")
    t = resolve_token(client, token, "transfer_from")
    atomic = await to_token_atomic(client, t, amount)
    return await send_and_wait(
        client, wait, lambda: wallet.write_contract(_address_of(t), TRANSFER_FROM, from_, to, atomic, gas=gas)
    )


def _topic(address: str | None) -> str | None:
    return "0x" + address[2:].lower().rjust(64, "0") if address else None


def _to_transfer(log: dict[str, Any]) -> TokenTransfer | None:
    topics = log.get("topics") or []
    if len(topics) != 3 or str(topics[0]).lower() != TRANSFER_TOPIC:
        return None  # not a standard Transfer (viem's strict decoding drops these too)
    return TokenTransfer(
        token=to_checksum_address(log["address"]),
        from_=to_checksum_address("0x" + topics[1][-40:]),
        to=to_checksum_address("0x" + topics[2][-40:]),
        amount=int(log.get("data") or "0x0", 16),
        transaction_hash=log["transactionHash"],
        block_number=int(log["blockNumber"], 16),
        log_index=int(log["logIndex"], 16),
    )


def transfer_key(t: TokenTransfer) -> str:
    """Stable identity of a transfer across re-deliveries: ``transactionHash:logIndex``."""
    return f"{t.transaction_hash}:{t.log_index}"


@dataclass(frozen=True)
class _Chunk:
    from_block: int
    to_block: int
    transfers: list[TokenTransfer]


async def _transfer_chunks(
    client: RpcClient,
    address: str,
    *,
    from_: str | None,
    to: str | None,
    from_block: int,
    to_block: int,
    max_block_range: int | None,
) -> AsyncIterator[_Chunk]:
    """Sequential ``eth_getLogs`` calls of at most ``max_block_range`` blocks each, ascending, each chunk sorted."""
    span = MAX_LOG_RANGE if max_block_range is None else max_block_range
    if span <= 0:
        raise RadiusPaymentError("config", f"max_block_range must be positive (got {span})")
    if from_block < 0 or from_block > to_block:
        raise RadiusPaymentError("config", f"Block range {from_block}..{to_block} is empty or negative")
    start = from_block
    while start <= to_block:
        end = start + span if start + span < to_block else to_block  # end - start <= span, which the node accepts
        logs = await client.get_logs(
            {
                "address": address,
                "topics": [TRANSFER_TOPIC, _topic(from_), _topic(to)],
                "fromBlock": hex(start),
                "toBlock": hex(end),
            }
        )
        transfers = [t for t in (_to_transfer(log) for log in logs) if t is not None]
        transfers.sort(key=lambda t: (t.block_number, t.log_index))
        yield _Chunk(start, end, transfers)
        start = end + 1


async def get_transfers(
    client: RpcClient,
    *,
    token: TokenInput | None = None,
    from_: str | None = None,
    to: str | None = None,
    from_block: int | None = None,
    to_block: int | None = None,
    max_block_range: int | None = None,
) -> list[TokenTransfer]:
    """Past ``Transfer`` events of a token, filtered by ``from_`` / ``to``, in (block_number, log_index) order.

    Defaults to the last :data:`MAX_LOG_RANGE` blocks before ``to_block`` (the head unless given); a
    wider range is fetched in sequential chunks, up to :data:`MAX_LOG_CHUNKS` calls.
    """
    address = _address_of(resolve_token(client, token, "get_transfers"))
    head = to_block if to_block is not None else await client.block_number()
    start = from_block if from_block is not None else (head - MAX_LOG_RANGE if head > MAX_LOG_RANGE else 0)
    span = MAX_LOG_RANGE if max_block_range is None else max_block_range
    if span > 0 and start <= head:
        chunks = (head - start) // (span + 1) + 1
        if chunks > MAX_LOG_CHUNKS:
            raise RadiusPaymentError(
                "config",
                f"get_transfers: {start}..{head} spans {head - start} blocks, {chunks} eth_getLogs calls of {span} (max {MAX_LOG_CHUNKS}); narrow the range or page it yourself",
            )
    out: list[TokenTransfer] = []
    async for chunk in _transfer_chunks(
        client, address, from_=from_, to=to, from_block=start, to_block=head, max_block_range=max_block_range
    ):
        out.extend(chunk.transfers)
    return out


class TransferWatch:
    """A running :func:`watch_transfers` poller. Call it (or :meth:`stop`) to unwatch."""

    def __init__(self) -> None:
        self.active = True
        self.task: asyncio.Task[None] | None = None

    def stop(self) -> None:
        self.active = False
        if self.task is not None and not self.task.done():
            self.task.cancel()

    __call__ = stop


async def _maybe_await(value: Any) -> None:
    if inspect.isawaitable(value):
        await value


def watch_transfers(
    client: RpcClient,
    on_transfer: Callable[[TokenTransfer], Any],
    *,
    token: TokenInput | None = None,
    from_: str | None = None,
    to: str | None = None,
    from_block: int | None = None,
    on_checkpoint: Callable[[int], Any] | None = None,
    on_error: Callable[[Exception], Any] | None = None,
    polling_interval: float | None = None,
    max_block_range: int | None = None,
) -> TransferWatch:
    """Subscribe to ``Transfer`` events of a token by polling the node. Needs a running event loop.

    Delivery is ordered and at-least-once: each poll fetches ``next..head`` (chunked), delivers every
    transfer (``on_transfer`` is awaited when it returns an awaitable), then advances ``next`` and
    calls ``on_checkpoint``; an error anywhere in a range leaves ``next`` where it was, so the range is
    retried on the next poll and nothing is skipped. Polls never overlap. Without ``from_block`` the
    watcher starts at the current head and delivers new transfers only.
    """
    address = _address_of(resolve_token(client, token, "watch_transfers"))
    interval = client.polling_interval if polling_interval is None else polling_interval
    watch = TransferWatch()

    async def run() -> None:
        nxt = from_block  # None until the first head is seen
        while watch.active:
            try:
                head = await client.block_number()
                if nxt is None:
                    nxt = head + 1
                if head >= nxt:
                    async for chunk in _transfer_chunks(
                        client,
                        address,
                        from_=from_,
                        to=to,
                        from_block=nxt,
                        to_block=head,
                        max_block_range=max_block_range,
                    ):
                        for t in chunk.transfers:
                            if not watch.active:
                                return
                            await _maybe_await(on_transfer(t))
                        if not watch.active:
                            return
                        nxt = chunk.to_block + 1  # only after the whole chunk is delivered
                        if on_checkpoint:
                            await _maybe_await(on_checkpoint(chunk.to_block))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if watch.active and on_error:
                    await _maybe_await(on_error(e))  # `nxt` untouched: retried next poll
            if watch.active:
                await asyncio.sleep(interval)

    watch.task = asyncio.get_running_loop().create_task(run())
    return watch


def format_token_amount(atomic: int, token: BalanceToken | PaymentAsset) -> str:
    """Display helper: atomic → "1.5 SBC" for a known token."""
    return f"{format_units(atomic, token.decimals)} {token.symbol}"


class Erc20Actions:
    """ERC-20 actions bound to a client and a default token (viem's ``erc20Actions()`` extension).

    Reads work on any :class:`RpcClient`; ``approve``, ``transfer`` and ``transfer_from`` need a
    :class:`WalletClient`.
    """

    def __init__(
        self, client: RpcClient, *, token: TokenInput | None = None, network: NetworkInput | None = None
    ) -> None:
        self.client = client
        self.token = configured_token(client, token, network, "Erc20Actions")

    def _t(self, token: TokenInput | None) -> TokenInput | None:
        return token or self.token

    async def get_token_metadata(self, token: TokenInput | None = None) -> TokenMetadata:
        return await get_token_metadata(self.client, self._t(token))

    async def get_allowance(self, owner: str, spender: str, *, token: TokenInput | None = None) -> int:
        return await get_allowance(self.client, owner, spender, token=self._t(token))

    async def approve(
        self, spender: str, amount: TokenAmount, *, token: TokenInput | None = None, **kw: Any
    ) -> TxResult:
        return await approve(self.client, spender, amount, token=self._t(token), **kw)  # type: ignore[arg-type]

    async def transfer(self, to: str, amount: TokenAmount, *, token: TokenInput | None = None, **kw: Any) -> TxResult:
        return await transfer(self.client, to, amount, token=self._t(token), **kw)  # type: ignore[arg-type]

    async def transfer_from(
        self, from_: str, to: str, amount: TokenAmount, *, token: TokenInput | None = None, **kw: Any
    ) -> TxResult:
        return await transfer_from(self.client, from_, to, amount, token=self._t(token), **kw)  # type: ignore[arg-type]

    async def get_transfers(self, *, token: TokenInput | None = None, **kw: Any) -> list[TokenTransfer]:
        return await get_transfers(self.client, token=self._t(token), **kw)

    def watch_transfers(
        self, on_transfer: Callable[[TokenTransfer], Any], *, token: TokenInput | None = None, **kw: Any
    ) -> TransferWatch:
        return watch_transfers(self.client, on_transfer, token=self._t(token), **kw)


__all__ = [
    "MAX_LOG_CHUNKS",
    "MAX_LOG_RANGE",
    "Erc20Actions",
    "TokenAmount",
    "TokenInput",
    "TokenMetadata",
    "TokenTransfer",
    "TransferWatch",
    "TxResult",
    "approve",
    "configured_token",
    "format_token_amount",
    "get_allowance",
    "get_token_metadata",
    "get_transfers",
    "resolve_token",
    "send_and_wait",
    "to_token_atomic",
    "transfer",
    "transfer_from",
    "transfer_key",
    "watch_transfers",
]
