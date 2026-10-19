"""Balance, ERC-20, Permit2 and settlement actions against a JSON-RPC stub, plus transaction signing."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from eth_account import Account
from eth_utils import keccak

from helpers import PERMIT2_ADDRESS, PK, SIGNER, recover
from radius_sdk import SBC, radius_testnet
from radius_sdk.balances import BalanceToken, get_balances, native_balance_bytecode
from radius_sdk.erc20 import (
    MAX_LOG_RANGE,
    TRANSFER_TOPIC,
    Erc20Actions,
    get_transfers,
    to_token_atomic,
    transfer_key,
    watch_transfers,
)
from radius_sdk.errors import RadiusPaymentError
from radius_sdk.permit2 import (
    PERMIT_TRANSFER_FROM_TYPES,
    Permit2Actions,
    Permit2Witness,
    is_permit2_nonce_used,
    permit2_witness_hash,
    permit2_witness_type_string,
    permit_witness_transfer_from_types,
)
from radius_sdk.rpc import RpcClient, WalletClient
from radius_sdk.settlement import get_settlement

ADDRESS = SIGNER.address
OTHER = "0x1eF420190c299D4d133fE9227F780D7d5cE91BeE"


def word(v: int) -> str:
    return "0x" + hex(v)[2:].rjust(64, "0")


class Node:
    """JSON-RPC stub keyed by method; ``eth_call`` answers by selector (or the native-balance init code)."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.handlers: dict[str, Callable[[list[Any]], Any]] = {}
        self.selectors: dict[str, Callable[[str], Any]] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.calls.append(body)
        method, params = body["method"], body["params"]
        try:
            if method == "eth_call":
                data = params[0]["data"]
                result = self.selectors[data[:10] if "to" in params[0] else "init"](data)
            else:
                result = self.handlers[method](params)
        except Exception as e:
            return httpx.Response(
                200, json={"jsonrpc": "2.0", "id": body["id"], "error": {"code": -32000, "message": str(e)}}
            )
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result})

    def client(self, cls: type = RpcClient, *args: Any) -> Any:
        return cls.for_network(
            radius_testnet, *args, http_client=httpx.AsyncClient(transport=httpx.MockTransport(self))
        )


class TestBalances:
    def test_native_balance_bytecode(self) -> None:
        assert native_balance_bytecode(ADDRESS) == "0x73" + ADDRESS[2:].lower() + "3160005260206000f3"
        with pytest.raises(ValueError):
            native_balance_bytecode("0x12")

    async def test_reports_native_tokens_and_aggregate_separately(self) -> None:
        node = Node()
        node.handlers["eth_getBalance"] = lambda p: hex(12_345_678 * 10**12)  # 12.345678 RUSD aggregate
        node.selectors["init"] = lambda d: word(2_345_678 * 10**12)  # 2.345678 native
        node.selectors["0x70a08231"] = lambda d: word(10_000_000)  # 10 SBC
        b = await get_balances(node.client(), ADDRESS)
        assert (b.native.raw, b.native.aggregate, b.native.convertible, b.native.raw_source) == (
            2_345_678 * 10**12,
            12_345_678 * 10**12,
            10 * 10**18,
            "evm",
        )
        assert (b.tokens[0].symbol, b.tokens[0].atomic, b.tokens[0].formatted, b.tokens[0].convertible) == (
            "SBC",
            10_000_000,
            "10",
            True,
        )
        assert b.total_formatted == "12.345678"
        init_call = next(c for c in node.calls if c["method"] == "eth_call" and "to" not in c["params"][0])
        assert init_call["params"][0]["data"] == native_balance_bytecode(ADDRESS)

    async def test_falls_back_to_derived_when_the_node_refuses_init_code(self) -> None:
        node = Node()
        node.handlers["eth_getBalance"] = lambda p: hex(12 * 10**18)
        node.selectors["init"] = lambda d: (_ for _ in ()).throw(RuntimeError("init code not allowed"))
        node.selectors["0x70a08231"] = lambda d: word(10_000_000)
        b = await get_balances(node.client(), ADDRESS, tokens=[BalanceToken(SBC.address, "SBC", 6)])
        assert (b.native.raw, b.native.raw_source) == (2 * 10**18, "derived")
        assert "init code not allowed" in (b.native.raw_error or "")
        with pytest.raises(Exception, match="init code"):
            await get_balances(node.client(), ADDRESS, native_balance="evm")


def transfer_log(block: int, index: int, value: int, frm: str = ADDRESS, to: str = OTHER) -> dict[str, Any]:
    return {
        "address": SBC.address.lower(),
        "topics": [TRANSFER_TOPIC, "0x" + frm[2:].lower().rjust(64, "0"), "0x" + to[2:].lower().rjust(64, "0")],
        "data": word(value),
        "transactionHash": "0x" + f"{block:064x}",
        "blockNumber": hex(block),
        "logIndex": hex(index),
    }


class TestErc20:
    async def test_amounts_and_metadata(self) -> None:
        node = Node()
        node.selectors["0x313ce567"] = lambda d: word(18)
        client = node.client()
        assert await to_token_atomic(client, SBC, "1.5") == 1_500_000
        assert await to_token_atomic(client, "0x" + "11" * 20, "1.5") == 15 * 10**17
        assert await to_token_atomic(client, SBC, 7) == 7
        for bad in ("1.0000001", "-1", "abc", -1):
            with pytest.raises(RadiusPaymentError):
                await to_token_atomic(client, SBC, bad)

    async def test_get_transfers_chunks_the_range_and_orders_by_position(self) -> None:
        node = Node()
        node.handlers["eth_blockNumber"] = lambda p: hex(3 * MAX_LOG_RANGE)
        ranges: list[tuple[int, int]] = []

        def logs(params: list[Any]) -> list[Any]:
            f = params[0]
            start, end = int(f["fromBlock"], 16), int(f["toBlock"], 16)
            ranges.append((start, end))
            assert f["topics"][1] is None and f["topics"][2] == "0x" + OTHER[2:].lower().rjust(64, "0")
            return [transfer_log(end, 1, 5), transfer_log(end, 0, 4)]

        node.handlers["eth_getLogs"] = logs
        out = await get_transfers(node.client(), to=OTHER, from_block=0, max_block_range=1_000_000)
        assert ranges == [(0, 1_000_000), (1_000_001, 2_000_001), (2_000_002, 3_000_000)]
        assert [(t.block_number, t.log_index) for t in out][:2] == [(1_000_000, 0), (1_000_000, 1)]
        assert out[0].to == OTHER and out[0].from_ == ADDRESS and transfer_key(out[0]).endswith(":0")
        with pytest.raises(RadiusPaymentError, match="eth_getLogs calls"):
            await get_transfers(node.client(), from_block=0, to_block=MAX_LOG_RANGE * 2000)

    async def test_watch_transfers_delivers_in_order_at_least_once_and_checkpoints(self) -> None:
        node = Node()
        heads = iter([10, 10, 20, 20, 20, 20])
        node.handlers["eth_blockNumber"] = lambda p: hex(next(heads, 20))
        fail_once = {"armed": True}

        def logs(params: list[Any]) -> list[Any]:
            start = int(params[0]["fromBlock"], 16)
            return [transfer_log(start + 1, 0, 1)]

        node.handlers["eth_getLogs"] = logs
        delivered: list[int] = []
        checkpoints: list[int] = []
        errors: list[str] = []

        def on_transfer(t: Any) -> None:
            if t.block_number == 12 and fail_once["armed"]:
                fail_once["armed"] = False
                raise RuntimeError("handler failed")
            delivered.append(t.block_number)

        watch = watch_transfers(
            node.client(),
            on_transfer,
            from_block=5,
            on_checkpoint=checkpoints.append,
            on_error=lambda e: errors.append(str(e)),
            polling_interval=0.001,
        )
        for _ in range(200):
            if len(checkpoints) >= 2:
                break
            await asyncio.sleep(0.005)
        watch()
        assert delivered[:2] == [6, 12] and checkpoints[:2] == [10, 20]
        assert errors == ["handler failed"]  # the failed range was retried, not skipped

    async def test_writes_are_signed_transactions_from_the_account(self) -> None:
        node = Node()
        node.handlers["eth_getTransactionCount"] = lambda p: "0x7"
        node.handlers["eth_getBlockByNumber"] = lambda p: {"baseFeePerGas": hex(1_000_000_000)}
        node.handlers["eth_maxPriorityFeePerGas"] = lambda p: hex(1)
        node.handlers["eth_estimateGas"] = lambda p: hex(60_000)
        sent: list[str] = []
        node.handlers["eth_sendRawTransaction"] = lambda p: sent.append(p[0]) or "0x" + "77" * 32
        node.handlers["eth_getTransactionReceipt"] = lambda p: {"status": "0x1", "blockNumber": "0x1", "logs": []}
        wallet = node.client(WalletClient, PK)
        result = await Erc20Actions(wallet).transfer(OTHER, "1.5")
        assert (result.status, result.explorer_url) == ("success", "https://testnet.radiustech.xyz/tx/0x" + "77" * 32)
        assert Account.recover_transaction(sent[0]) == SIGNER.address
        from eth_account.typed_transactions import TypedTransaction
        from hexbytes import HexBytes

        tx = TypedTransaction.from_bytes(HexBytes(sent[0])).as_dict()
        assert (tx["chainId"], tx["nonce"], tx["gas"], tx["maxFeePerGas"], tx["to"].hex().lower()) == (
            72344,
            7,
            60_000,
            1_200_000_001,
            SBC.address[2:].lower(),
        )
        assert tx["data"].hex().startswith("a9059cbb")  # transfer(address,uint256)
        pending = await Erc20Actions(wallet).approve(OTHER, 5, wait=False)
        assert pending.status == "pending"

    async def test_actions_on_an_unknown_chain_need_a_token(self) -> None:
        client = RpcClient("http://rpc.test")
        with pytest.raises(RadiusPaymentError, match="no default token"):
            await Erc20Actions(client).get_allowance(ADDRESS, OTHER)
        with pytest.raises(RadiusPaymentError, match="is chain 84532"):
            Erc20Actions(RpcClient.for_network(radius_testnet), network="base-sepolia")


X402_WITNESS = Permit2Witness(
    type_name="Witness",
    types={"Witness": [{"name": "to", "type": "address"}, {"name": "validAfter", "type": "uint256"}]},
    value={"to": OTHER, "validAfter": 0},
)


class TestPermit2:
    def test_witness_type_string_matches_the_x402_layout(self) -> None:
        assert permit2_witness_type_string(X402_WITNESS) == (
            "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)"
        )
        type_hash = keccak(text="Witness(address to,uint256 validAfter)")
        expected = keccak(type_hash + bytes(12) + bytes.fromhex(OTHER[2:]) + bytes(32))
        assert permit2_witness_hash(X402_WITNESS) == "0x" + expected.hex()

    async def test_signs_transfers_and_allowances_recoverable_to_the_owner(self) -> None:
        node = Node()
        node.selectors["0x927da105"] = lambda d: word(0) + word(0)[2:] + word(3)[2:]  # allowance(...) → (0, 0, nonce 3)
        wallet = node.client(WalletClient, PK)
        actions = Permit2Actions(wallet)
        signed = await actions.sign_permit2_transfer("0.01", OTHER, nonce=1, deadline=2**40)
        domain = {"name": "Permit2", "chainId": 72344, "verifyingContract": PERMIT2_ADDRESS}
        assert (
            recover(
                domain, PERMIT_TRANSFER_FROM_TYPES, "PermitTransferFrom", signed.permit.message(OTHER), signed.signature
            )
            == SIGNER.address
        )
        witnessed = await actions.sign_permit2_transfer("0.01", OTHER, witness=X402_WITNESS)
        message = {**witnessed.permit.message(OTHER), "witness": dict(X402_WITNESS.value)}
        types = permit_witness_transfer_from_types(X402_WITNESS)
        assert recover(domain, types, "PermitWitnessTransferFrom", message, witnessed.signature) == SIGNER.address
        allowance = await actions.sign_permit2_allowance("5", OTHER, 2**40)
        assert allowance.permit_single.nonce == 3
        with pytest.raises(RadiusPaymentError, match="in the past"):
            await actions.sign_permit2_transfer("0.01", OTHER, deadline=1)

    async def test_nonce_bitmap_lookup(self) -> None:
        node = Node()
        positions: list[int] = []

        def bitmap(data: str) -> str:
            positions.append(int(data[-64:], 16))
            return word(1 << 5)

        node.selectors["0x4fe02b44"] = bitmap
        assert await is_permit2_nonce_used(node.client(), ADDRESS, (7 << 8) | 5)
        assert not await is_permit2_nonce_used(node.client(), ADDRESS, (7 << 8) | 6)
        assert positions == [7, 7]


async def test_get_settlement_reads_payment_asset_transfers() -> None:
    node = Node()
    receipt = {
        "status": "0x1",
        "blockNumber": "0x10",
        "logs": [transfer_log(16, 0, 1000), {**transfer_log(16, 1, 5), "address": "0x" + "22" * 20}],
    }
    node.handlers["eth_getTransactionReceipt"] = lambda p: receipt if p[0] == "0xaa" else None
    client = node.client()
    s = await get_settlement(radius_testnet, "0xaa", client)
    assert s is not None
    assert (s.status, s.block_number, s.paid(), s.paid(OTHER), s.paid_formatted(OTHER), s.paid(ADDRESS)) == (
        "success",
        16,
        1000,
        1000,
        "0.001 SBC",
        0,
    )
    assert await get_settlement(radius_testnet, "0xbb", client) is None
