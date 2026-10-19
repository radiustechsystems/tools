"""On-chain view of a settlement transaction, for reconciling receipts before charging again."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from eth_utils import to_checksum_address

from .amounts import format_amount
from .erc20 import TRANSFER_TOPIC
from .networks import PaymentNetwork, explorer_tx_url
from .rpc import RpcClient, RpcError


@dataclass(frozen=True)
class SettlementTransfer:
    from_: str
    to: str
    #: Atomic units of the network's payment asset.
    amount: int


@dataclass(frozen=True)
class Settlement:
    transaction: str
    status: Literal["success", "reverted"]
    block_number: int
    #: Transfers of the payment asset that happened in this transaction.
    transfers: list[SettlementTransfer]
    #: The network's payment asset, for :meth:`paid_formatted`.
    network: PaymentNetwork
    explorer_url: str | None = None

    def paid(self, to: str | None = None) -> int:
        """Total of the payment asset that reached ``to`` (all transfers if omitted)."""
        return sum(t.amount for t in self.transfers if to is None or t.to.lower() == to.lower())

    def paid_formatted(self, to: str | None = None) -> str:
        return format_amount(self.paid(to), self.network.asset.decimals, self.network.asset.symbol)


async def get_settlement(network: PaymentNetwork, tx_hash: str, client: RpcClient | None = None) -> Settlement | None:
    """Look up a settlement transaction on-chain.

    Returns None while the transaction is unknown to the node (not yet mined, or never existed). Use it
    to reconcile a timed-out payment before authorising another charge.
    """
    owned = client is None
    rpc = client or RpcClient.for_network(network)
    try:
        try:
            receipt = await rpc.get_transaction_receipt(tx_hash)
        except RpcError as e:
            if "not found" in e.message.lower() or "could not be found" in e.message.lower():
                return None
            raise
        if not receipt:
            return None
        asset = network.asset.address.lower()
        transfers = [
            SettlementTransfer(
                from_=to_checksum_address("0x" + log["topics"][1][-40:]),
                to=to_checksum_address("0x" + log["topics"][2][-40:]),
                amount=int(log.get("data") or "0x0", 16),
            )
            for log in receipt.get("logs") or []
            if str(log.get("address", "")).lower() == asset
            and len(log.get("topics") or []) == 3
            and str(log["topics"][0]).lower() == TRANSFER_TOPIC
        ]
        return Settlement(
            transaction=tx_hash,
            status="success" if receipt.get("status") in ("0x1", 1) else "reverted",
            block_number=int(receipt.get("blockNumber") or "0x0", 16),
            transfers=transfers,
            network=network,
            explorer_url=explorer_tx_url(network, tx_hash),
        )
    finally:
        if owned:
            await rpc.aclose()
