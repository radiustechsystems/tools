"""Balance queries that account for how Radius differs from other EVM chains.

On Radius, ``eth_getBalance`` does not return the account's native RUSD. It returns native RUSD
**plus** the account's convertible stablecoin holdings (SBC) valued 1:1 through the Turnstile,
scaled to 18 decimals, so that wallets and tooling see everything the account can spend. Reading
``eth_getBalance`` and an ERC-20 ``balanceOf`` and adding them double-counts the stablecoin.

The EVM itself is unchanged: the ``BALANCE`` opcode (and Solidity's ``address.balance``) sees only
the native amount. :func:`get_native_balance` uses that to read the raw native balance with a plain
``eth_call`` whose init code executes ``BALANCE`` and returns it, so no contract needs to be deployed
and any standard node answers it. Stablecoin balances are ordinary ERC-20 ``balanceOf`` reads and
are never aggregated.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from .networks import SBC, NetworkInput, PaymentNetwork, preset_for_chain_id, radius_mainnet, resolve_network
from .rpc import AbiFunction, RpcClient, block_param

_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
_WORD = re.compile(r"^0x[0-9a-fA-F]{64}$")
BALANCE_OF = AbiFunction("balanceOf", ("address",), ("uint256",))


@dataclass(frozen=True)
class BalanceToken:
    """An ERC-20 to include in a balance query. :class:`~radius_sdk.networks.PaymentAsset` values work too."""

    address: str
    symbol: str
    decimals: int
    #: Whether the Turnstile counts this token in ``eth_getBalance`` (SBC: yes). Defaults to true for
    #: SBC and false otherwise.
    convertible: bool | None = None


@dataclass(frozen=True)
class TokenBalance:
    address: str
    symbol: str
    decimals: int
    convertible: bool
    #: Raw ERC-20 ``balanceOf``, in the token's base units.
    atomic: int
    #: Display amount, e.g. "10.5".
    formatted: str


@dataclass(frozen=True)
class NativeBalance:
    symbol: str
    decimals: int
    #: Native RUSD only, in wei: what the EVM ``BALANCE`` opcode sees. Excludes stablecoins.
    raw: int
    raw_formatted: str
    #: What ``eth_getBalance`` returns: ``raw`` plus convertible stablecoins valued 1:1, in wei.
    aggregate: int
    aggregate_formatted: str
    #: ``aggregate - raw``: the stablecoin value the Turnstile would convert on demand, in wei.
    convertible: int
    convertible_formatted: str
    #: ``evm``: read with the ``BALANCE`` opcode; ``derived``: convertible token balances subtracted
    #: from ``aggregate`` because the EVM read failed (see ``raw_error``).
    raw_source: Literal["evm", "derived"]
    raw_error: str | None = None


@dataclass(frozen=True)
class AccountBalances:
    address: str
    native: NativeBalance
    #: One entry per requested token, in the order requested.
    tokens: list[TokenBalance]
    #: ``native.raw`` plus the convertible tokens valued 1:1, in 18 decimals.
    total: int
    total_formatted: str


def format_units(value: int, decimals: int) -> str:
    """viem's ``formatUnits``: atomic integer to a decimal string without trailing zeros."""
    neg = value < 0
    s = str(-value if neg else value).rjust(decimals + 1, "0")
    whole, frac = s[: len(s) - decimals], s[len(s) - decimals :].rstrip("0") if decimals else ""
    return f"{'-' if neg else ''}{whole}{'.' + frac if frac else ''}"


def native_balance_bytecode(address: str) -> str:
    """EVM init code that returns ``BALANCE(address)`` as a 32-byte word.

    Sent as an ``eth_call`` with no ``to``, a node executes it as contract-creation code and returns
    its return data::

        PUSH20 <address> BALANCE PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN
    """
    if not _ADDRESS.match(address):
        raise ValueError(f"native_balance_bytecode: not an address: {address}")
    return f"0x73{address[2:].lower()}3160005260206000f3"


async def get_native_balance(
    client: RpcClient, address: str, *, block_number: int | None = None, block_tag: str | None = None
) -> int:
    """The account's native RUSD balance in wei, **excluding** convertible stablecoins."""
    result = await client.request(
        "eth_call", [{"data": native_balance_bytecode(address)}, block_param(block_number, block_tag)]
    )
    if not isinstance(result, str) or not _WORD.match(result):
        raise ValueError(
            f"get_native_balance: eth_call returned {result!r} instead of a 32-byte word; the node may not execute init code in eth_call"
        )
    return int(result, 16)


async def get_aggregate_balance(
    client: RpcClient, address: str, *, block_number: int | None = None, block_tag: str | None = None
) -> int:
    """What ``eth_getBalance`` returns on Radius, in wei: native RUSD plus convertible stablecoins valued 1:1."""
    return await client.get_balance(address, block_param(block_number, block_tag))


async def get_token_balance(
    client: RpcClient,
    address: str,
    token: BalanceToken,
    *,
    block_number: int | None = None,
    block_tag: str | None = None,
) -> TokenBalance:
    """Raw ERC-20 ``balanceOf`` for one token (SBC or any other), never aggregated."""
    atomic = await client.read_contract(token.address, BALANCE_OF, address, block=block_param(block_number, block_tag))
    return TokenBalance(
        address=token.address,
        symbol=token.symbol,
        decimals=token.decimals,
        convertible=_is_convertible(token),
        atomic=atomic,
        formatted=format_units(atomic, token.decimals),
    )


async def get_balances(
    client: RpcClient,
    address: str,
    *,
    tokens: Sequence[BalanceToken] | None = None,
    network: NetworkInput | None = None,
    native_balance: Literal["auto", "evm", "derived"] = "auto",
    block_number: int | None = None,
    block_tag: str | None = None,
) -> AccountBalances:
    """Native and stablecoin balances of one account, each reported separately, plus the aggregate.

    One ``eth_getBalance``, one ``eth_call`` per token, and one ``eth_call`` for the raw native
    balance, all concurrent. ``native_balance``: ``auto`` (default) reads the EVM balance and falls
    back to subtracting convertible token balances if that call fails; ``evm`` raises instead;
    ``derived`` only subtracts.
    """
    token_list = list(tokens) if tokens is not None else default_tokens(client, network)
    block: dict[str, Any] = {"block_number": block_number, "block_tag": block_tag}
    native_currency = client.chain.native_currency if client.chain else radius_mainnet.chain.native_currency

    async def read_native() -> tuple[int | None, str | None]:
        if native_balance == "derived":
            return None, None
        try:
            return await get_native_balance(client, address, **block), None
        except Exception as e:
            if native_balance == "evm":
                raise
            return None, str(e)

    aggregate, token_balances, (evm_raw, evm_error) = await asyncio.gather(
        get_aggregate_balance(client, address, **block),
        asyncio.gather(*(get_token_balance(client, address, t, **block) for t in token_list)),
        read_native(),
    )
    token_balances = list(token_balances)
    convertible_wei = sum(
        _to_wei(t.atomic, t.decimals, native_currency.decimals) for t in token_balances if t.convertible
    )
    if evm_raw is not None:
        raw, raw_source = evm_raw, "evm"
    else:
        raw, raw_source = (aggregate - convertible_wei if aggregate > convertible_wei else 0), "derived"
    convertible = aggregate - raw if aggregate > raw else 0
    total = raw + convertible_wei

    def fmt(v: int) -> str:
        return format_units(v, native_currency.decimals)

    return AccountBalances(
        address=address,
        native=NativeBalance(
            symbol=native_currency.symbol,
            decimals=native_currency.decimals,
            raw=raw,
            raw_formatted=fmt(raw),
            aggregate=aggregate,
            aggregate_formatted=fmt(aggregate),
            convertible=convertible,
            convertible_formatted=fmt(convertible),
            raw_source=raw_source,  # type: ignore[arg-type]
            raw_error=evm_error,
        ),
        tokens=token_balances,
        total=total,
        total_formatted=fmt(total),
    )


class RadiusActions:
    """Balance actions bound to a client, with default tokens/network (viem's ``radiusActions()`` extension)."""

    def __init__(
        self, client: RpcClient, *, tokens: Sequence[BalanceToken] | None = None, network: NetworkInput | None = None
    ) -> None:
        self.client = client
        self._tokens = tokens
        self._network = network

    async def get_native_balance(self, address: str, **kw: object) -> int:
        return await get_native_balance(self.client, address, **kw)  # type: ignore[arg-type]

    async def get_aggregate_balance(self, address: str, **kw: object) -> int:
        return await get_aggregate_balance(self.client, address, **kw)  # type: ignore[arg-type]

    async def get_token_balance(self, address: str, token: BalanceToken, **kw: object) -> TokenBalance:
        return await get_token_balance(self.client, address, token, **kw)  # type: ignore[arg-type]

    async def get_balances(self, address: str, **kw: object) -> AccountBalances:
        kw.setdefault("tokens", self._tokens)
        kw.setdefault("network", self._network)
        return await get_balances(self.client, address, **kw)  # type: ignore[arg-type]


def radius_actions(
    client: RpcClient, *, tokens: Sequence[BalanceToken] | None = None, network: NetworkInput | None = None
) -> RadiusActions:
    return RadiusActions(client, tokens=tokens, network=network)


def default_tokens(client: RpcClient, network: NetworkInput | None = None) -> list[BalanceToken]:
    """Tokens :func:`get_balances` reads by default: the network's payment asset, convertible on Radius networks."""
    net: PaymentNetwork | None = (
        resolve_network(network)
        if network is not None
        else preset_for_chain_id(client.chain.id if client.chain else None)
    )
    asset = net.asset if net else SBC
    return [BalanceToken(asset.address, asset.symbol, asset.decimals, net.radius if net else True)]


def _is_convertible(token: BalanceToken) -> bool:
    convertible = getattr(token, "convertible", None)  # PaymentAsset values have none
    if convertible is not None:
        return bool(convertible)
    return token.address.lower() == SBC.address.lower()


def _to_wei(atomic: int, decimals: int, native_decimals: int) -> int:
    """Rescale a token amount to the native currency's decimals at face value (SBC 10^6 → RUSD 10^18)."""
    if decimals == native_decimals:
        return atomic
    if decimals < native_decimals:
        return atomic * 10 ** (native_decimals - decimals)
    return atomic // 10 ** (decimals - native_decimals)
