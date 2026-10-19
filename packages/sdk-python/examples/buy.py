"""Pay a URL from the command line (an x402 or MPP seller on Radius).

    RADIUS_NETWORK=testnet RADIUS_PRIVATE_KEY=0x… uv run --extra client python examples/buy.py http://localhost:8791/api/lookup

Spends from the key's wallet: use a testnet key, and fund it with ``--fund`` (faucet drip) first.
"""

from __future__ import annotations

import asyncio
import sys

from radius_sdk import RadiusPaymentError, get_payment_receipt, radius_env
from radius_sdk.client import create_radius_fetch


async def main(url: str, fund: bool) -> int:
    config = {"network": "testnet", "max_per_request": "0.01", **radius_env()}
    if "signer" not in config:
        print("Set RADIUS_PRIVATE_KEY", file=sys.stderr)
        return 2
    async with create_radius_fetch(
        **config,
        on_payment_required=lambda offer: (
            print(f"paying {offer.amount_formatted} to {offer.pay_to} ({offer.protocol})") or True
        ),
    ) as pay:
        if fund:
            print("faucet:", await pay.fund())
        atomic, formatted = await pay.balance()
        print(f"{pay.address} holds {formatted} on {pay.network.name}")
        try:
            res = await pay(url)
        except RadiusPaymentError as e:
            print(f"payment failed ({e.code}): {e}", file=sys.stderr)
            return 1
        print(res.status_code, res.text)
        receipt = get_payment_receipt(res, pay.network)
        if receipt:
            print("receipt:", receipt.transaction, receipt.explorer_url)
    return 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--fund"]
    if not args:
        print(__doc__)
        sys.exit(2)
    sys.exit(asyncio.run(main(args[0], "--fund" in sys.argv)))
