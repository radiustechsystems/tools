"""Configuration from environment variables, with radius-cli's variable names."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from typing import Any

from .networks import NETWORK_NAMES

_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
_PRIVATE_KEY = re.compile(r"^0x[0-9a-fA-F]{64}$")


def radius_env(env: Mapping[str, str | None] | None = None) -> dict[str, Any]:
    """Read SDK options from environment-style variables (``os.environ`` by default).

    Spread the result into ``radius_payments(**radius_env(), ...)`` or
    ``create_radius_fetch(**radius_env(), ...)``; explicit keyword arguments given after it win.

    ============================  ==========================================================
    Variable                      Maps to
    ============================  ==========================================================
    RADIUS_NETWORK                ``network``: a preset id ('mainnet' default)
    RADIUS_RPC_URL                ``rpc_url``
    RADIUS_FACILITATOR_URL        ``facilitator_url``
    RADIUS_FACILITATOR_API_KEY    ``facilitator={"api_key": ...}``
    RADIUS_ASSET_ADDRESS          ``asset={"address": ...}`` (payment token; default SBC)
    RADIUS_SBC_ADDRESS            alias of RADIUS_ASSET_ADDRESS (radius-cli's name)
    RADIUS_PAY_TO                 ``pay_to`` (server)
    RADIUS_PRIVATE_KEY            ``signer`` (client)
    RADIUS_MAX_PER_REQUEST        ``max_per_request`` (client)
    ============================  ==========================================================
    """
    if env is None:
        env = os.environ
    network = env.get("RADIUS_NETWORK") or "mainnet"
    if network not in NETWORK_NAMES:
        raise ValueError(f"RADIUS_NETWORK must be one of {', '.join(NETWORK_NAMES)} (got '{network}')")
    out: dict[str, Any] = {"network": network}
    if env.get("RADIUS_RPC_URL"):
        out["rpc_url"] = env["RADIUS_RPC_URL"]
    if env.get("RADIUS_FACILITATOR_URL"):
        out["facilitator_url"] = env["RADIUS_FACILITATOR_URL"]
    if env.get("RADIUS_FACILITATOR_API_KEY"):
        out["facilitator"] = {"api_key": env["RADIUS_FACILITATOR_API_KEY"]}
    asset_address = env.get("RADIUS_ASSET_ADDRESS") or env.get("RADIUS_SBC_ADDRESS")
    if asset_address:
        name = "RADIUS_ASSET_ADDRESS" if env.get("RADIUS_ASSET_ADDRESS") else "RADIUS_SBC_ADDRESS"
        out["asset"] = {"address": _require_address(asset_address, name)}
    if env.get("RADIUS_PAY_TO"):
        out["pay_to"] = _require_address(env["RADIUS_PAY_TO"] or "", "RADIUS_PAY_TO")
    key = env.get("RADIUS_PRIVATE_KEY")
    if key:
        if not _PRIVATE_KEY.match(key):
            raise ValueError("RADIUS_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key")
        out["signer"] = key
    if env.get("RADIUS_MAX_PER_REQUEST"):
        out["max_per_request"] = env["RADIUS_MAX_PER_REQUEST"]
    return out


def _require_address(value: str, name: str) -> str:
    if not _ADDRESS.match(value):
        raise ValueError(f"{name} is not a valid 0x address: {value}")
    return value
