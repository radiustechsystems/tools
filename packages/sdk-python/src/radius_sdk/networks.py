"""Payment networks: where a payment settles and in which token.

Chain identity (id, RPC, explorer, native currency) is a :class:`Chain`, with the same values as
viem's entries the TypeScript SDK uses. A :class:`PaymentNetwork` wraps a chain with what x402
needs (payment asset, default facilitator, x402 v1 network names) and exposes a few fields derived
from the chain for convenience.

Presets: Radius mainnet and testnet (the default), Base and Base Sepolia. Any other EVM chain is one
:func:`define_payment_network` call away.

Radius values verified against docs.radiustech.xyz and the live facilitator ``/supported``
responses (2026-09-11); Base USDC values match x402's default assets.
"""

from __future__ import annotations

import dataclasses
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Union

Address = str
"""A ``0x``-prefixed 20-byte hex address."""
Caip2 = str
"""A CAIP-2 network id, ``eip155:<chainId>``."""


@dataclass(frozen=True)
class NativeCurrency:
    name: str
    symbol: str
    decimals: int


@dataclass(frozen=True)
class BlockExplorer:
    name: str
    url: str


@dataclass(frozen=True)
class Chain:
    """An EVM chain: the source of truth for chain id, RPC, explorer and native currency."""

    id: int
    name: str
    native_currency: NativeCurrency
    rpc_url: str
    block_explorer: BlockExplorer | None = None
    testnet: bool = False


@dataclass(frozen=True)
class PaymentAsset:
    """The ERC-20 a network's payments are made in."""

    #: ERC-20 contract address.
    address: Address
    symbol: str
    decimals: int
    #: EIP-712 domain name (EIP-3009 / EIP-2612).
    name: str
    #: EIP-712 domain version (EIP-3009 / EIP-2612).
    version: str


@dataclass(frozen=True)
class PaymentNetwork:
    """A chain plus its payment asset and default facilitator. Build one with :func:`define_payment_network`."""

    #: Preset id ('radius', 'radius-testnet', 'base', 'base-sepolia') or a custom network's name.
    name: str
    #: The chain: the source of truth for chain id, RPC, explorer and native currency.
    chain: Chain
    #: ``chain.id``.
    chain_id: int
    #: CAIP-2 identifier used on the x402 wire, e.g. ``eip155:723487``.
    network: Caip2
    #: ``chain.rpc_url``.
    rpc_url: str
    #: Payment asset: SBC on Radius, USDC on Base.
    asset: PaymentAsset
    #: Facilitator sellers use when they do not name one. Unset for Base mainnet.
    facilitator_url: str | None = None
    #: ``chain.block_explorer.url``, when the chain declares one.
    explorer_url: str | None = None
    #: Radius faucet API base URL (drips SBC; testnet ~0.5/request, mainnet ~0.01/day).
    faucet_url: str | None = None
    #: ``chain.testnet``.
    testnet: bool = False
    #: A Radius network: ``eth_getBalance`` includes convertible stablecoins (the Turnstile) and gas
    #: can be paid in SBC. False for every other chain.
    radius: bool = False
    #: Names x402 v1 challenges use for this network instead of CAIP-2 (e.g. ``base``).
    v1_names: tuple[str, ...] = field(default_factory=tuple)


#: Radius mainnet (id 723487). Same values as viem's ``radius``.
radius_mainnet_chain = Chain(
    id=723_487,
    name="Radius Network",
    native_currency=NativeCurrency(name="Radius USD", symbol="RUSD", decimals=18),
    rpc_url="https://rpc.radiustech.xyz",
    block_explorer=BlockExplorer(name="Radius Network Explorer", url="https://network.radiustech.xyz"),
    testnet=False,
)

#: Radius testnet (id 72344). Same values as viem's ``radiusTestnet``.
radius_testnet_chain = Chain(
    id=72_344,
    name="Radius Test Network",
    native_currency=NativeCurrency(name="Radius USD", symbol="RUSD", decimals=18),
    rpc_url="https://rpc.testnet.radiustech.xyz",
    block_explorer=BlockExplorer(name="Radius Test Network Explorer", url="https://testnet.radiustech.xyz"),
    testnet=True,
)

#: Base (id 8453). Same values as viem's ``base``.
base_chain = Chain(
    id=8453,
    name="Base",
    native_currency=NativeCurrency(name="Ether", symbol="ETH", decimals=18),
    rpc_url="https://mainnet.base.org",
    block_explorer=BlockExplorer(name="Basescan", url="https://basescan.org"),
    testnet=False,
)

#: Base Sepolia (id 84532). Same values as viem's ``baseSepolia``.
base_sepolia_chain = Chain(
    id=84_532,
    name="Base Sepolia",
    native_currency=NativeCurrency(name="Sepolia Ether", symbol="ETH", decimals=18),
    rpc_url="https://sepolia.base.org",
    block_explorer=BlockExplorer(name="Basescan", url="https://sepolia.basescan.org"),
    testnet=True,
)

#: SBC is deployed deterministically: same address on Radius mainnet and testnet.
SBC = PaymentAsset(
    address="0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb",
    symbol="SBC",
    decimals=6,
    name="Stable Coin",
    version="1",
)

#: Circle USDC on Base.
USDC_BASE = PaymentAsset(
    address="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol="USDC",
    decimals=6,
    name="USD Coin",
    version="2",
)

#: Circle USDC on Base Sepolia (its EIP-712 name differs from mainnet's).
USDC_BASE_SEPOLIA = PaymentAsset(
    address="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    symbol="USDC",
    decimals=6,
    name="USDC",
    version="2",
)

#: Canonical Uniswap Permit2 (same address on every EVM chain).
PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
#: x402ExactPermit2Proxy: the Permit2 spender payers sign for in the ``exact`` scheme.
X402_EXACT_PERMIT2_PROXY: Address = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001"

NetworkName = Literal["radius", "radius-testnet", "base", "base-sepolia", "mainnet", "testnet"]


@dataclass(frozen=True)
class PaymentNetworkConfig:
    """Any EVM chain that can carry x402 payments (see :func:`define_payment_network`)."""

    chain: Chain
    asset: PaymentAsset
    name: str | None = None
    facilitator_url: str | None = None
    rpc_url: str | None = None
    explorer_url: str | None = None
    faucet_url: str | None = None
    radius: bool = False
    v1_names: Sequence[str] = ()


NetworkInput = Union[str, PaymentNetwork, PaymentNetworkConfig, Mapping[str, Any]]
"""A preset id, a :class:`PaymentNetwork`, or a config for :func:`define_payment_network`."""


@dataclass(frozen=True)
class NetworkOverrides:
    rpc_url: str | None = None
    facilitator_url: str | None = None
    explorer_url: str | None = None
    faucet_url: str | None = None
    #: Override (part of) the payment asset, e.g. a different token on the same chain.
    asset: Mapping[str, Any] | PaymentAsset | None = None

    def is_empty(self) -> bool:
        return all(getattr(self, f.name) is None for f in dataclasses.fields(self))


def overrides_of(
    *,
    rpc_url: str | None = None,
    facilitator_url: str | None = None,
    explorer_url: str | None = None,
    faucet_url: str | None = None,
    asset: Mapping[str, Any] | PaymentAsset | None = None,
) -> NetworkOverrides | None:
    """The override fields of an options set, or None when none is set (so presets stay identical)."""
    o = NetworkOverrides(rpc_url, facilitator_url, explorer_url, faucet_url, asset)
    return None if o.is_empty() else o


def _from_chain(
    chain: Chain,
    *,
    name: str | None,
    facilitator_url: str | None,
    faucet_url: str | None,
    asset: PaymentAsset,
    radius: bool,
    v1_names: tuple[str, ...],
) -> PaymentNetwork:
    if not chain.rpc_url:
        raise ValueError(f"Chain {chain.id} ({chain.name}) declares no default HTTP RPC URL")
    return PaymentNetwork(
        name=name or chain.name,
        chain=chain,
        chain_id=chain.id,
        network=f"eip155:{chain.id}",
        rpc_url=chain.rpc_url,
        facilitator_url=facilitator_url,
        explorer_url=chain.block_explorer.url if chain.block_explorer else None,
        faucet_url=faucet_url,
        asset=asset,
        testnet=chain.testnet,
        radius=radius,
        v1_names=v1_names,
    )


def _with_chain_overrides(chain: Chain, *, rpc_url: str | None, explorer_url: str | None) -> Chain:
    """``chain`` with its default RPC / explorer replaced (a new chain; the input is untouched)."""
    if not rpc_url and not explorer_url:
        return chain
    explorer_name = chain.block_explorer.name if chain.block_explorer else "Explorer"
    return dataclasses.replace(
        chain,
        rpc_url=_strip_trailing_slash(rpc_url) if rpc_url else chain.rpc_url,
        block_explorer=BlockExplorer(name=explorer_name, url=_strip_trailing_slash(explorer_url))
        if explorer_url
        else chain.block_explorer,
    )


def _strip_trailing_slash(url: str) -> str:
    return url.rstrip("/")


def define_payment_network(
    config: PaymentNetworkConfig | None = None,
    /,
    **kwargs: Any,
) -> PaymentNetwork:
    """Build a network from a chain and its payment asset.

    Pass a :class:`PaymentNetworkConfig`, or its fields as keyword arguments.
    """
    if config is None:
        config = PaymentNetworkConfig(**kwargs)
    elif kwargs:
        config = dataclasses.replace(config, **kwargs)
    if not isinstance(config.chain, Chain) or not isinstance(config.chain.id, int):
        raise ValueError("define_payment_network: chain must be a Chain")
    if not config.asset or not getattr(config.asset, "address", None):
        raise ValueError("define_payment_network: asset is required")
    asset = config.asset if isinstance(config.asset, PaymentAsset) else PaymentAsset(**dict(config.asset))
    return _from_chain(
        _with_chain_overrides(config.chain, rpc_url=config.rpc_url, explorer_url=config.explorer_url),
        name=config.name,
        facilitator_url=_strip_trailing_slash(config.facilitator_url) if config.facilitator_url else None,
        faucet_url=config.faucet_url,
        asset=asset,
        radius=config.radius,
        v1_names=tuple(config.v1_names),
    )


radius_mainnet = define_payment_network(
    chain=radius_mainnet_chain,
    name="radius",
    facilitator_url="https://facilitator.radiustech.xyz",
    faucet_url="https://network.radiustech.xyz/api/v1/faucet",
    asset=SBC,
    radius=True,
)

radius_testnet = define_payment_network(
    chain=radius_testnet_chain,
    name="radius-testnet",
    facilitator_url="https://facilitator.testnet.radiustech.xyz",
    faucet_url="https://testnet.radiustech.xyz/api/v1/faucet",
    asset=SBC,
    radius=True,
)

base_mainnet = define_payment_network(chain=base_chain, name="base", asset=USDC_BASE, v1_names=("base",))

base_sepolia = define_payment_network(
    chain=base_sepolia_chain,
    name="base-sepolia",
    facilitator_url="https://x402.org/facilitator",
    asset=USDC_BASE_SEPOLIA,
    v1_names=("base-sepolia",),
)

#: Every preset, Radius first.
PRESET_NETWORKS: tuple[PaymentNetwork, ...] = (radius_mainnet, radius_testnet, base_mainnet, base_sepolia)

_PRESETS_BY_NAME: dict[str, PaymentNetwork] = {
    "radius": radius_mainnet,
    "mainnet": radius_mainnet,
    "radius-testnet": radius_testnet,
    "testnet": radius_testnet,
    "base": base_mainnet,
    "base-sepolia": base_sepolia,
}

#: Every preset id, aliases included.
NETWORK_NAMES: tuple[str, ...] = tuple(_PRESETS_BY_NAME)


def _config_from_mapping(m: Mapping[str, Any]) -> PaymentNetworkConfig:
    known = {f.name for f in dataclasses.fields(PaymentNetworkConfig)}
    unknown = set(m) - known
    if unknown:
        raise ValueError(f"resolve_network: unknown network config keys {sorted(unknown)}")
    return PaymentNetworkConfig(**dict(m))


def resolve_network(input: NetworkInput | None = None, overrides: NetworkOverrides | None = None) -> PaymentNetwork:
    """Resolve a network from a preset id, a network, or a config, applying overrides.

    Defaults to Radius mainnet.
    """
    if input is None:
        base = radius_mainnet
    elif isinstance(input, str):
        if input not in _PRESETS_BY_NAME:
            raise ValueError(
                f"resolve_network: unknown network '{input}' (expected one of {', '.join(_PRESETS_BY_NAME)}, or a network object)"
            )
        base = _PRESETS_BY_NAME[input]
    elif isinstance(input, PaymentNetwork):
        base = input
    elif isinstance(input, PaymentNetworkConfig):
        base = define_payment_network(input)
    elif isinstance(input, Mapping):
        base = define_payment_network(_config_from_mapping(input))
    else:
        raise ValueError(f"resolve_network: unknown network '{input!r}'")

    # A replaced preset (`dataclasses.replace(radius_testnet, rpc_url=...)`) leaves `chain` stale;
    # treat convenience fields that disagree with the chain as overrides of it.
    rpc_url = (overrides.rpc_url if overrides else None) or (
        base.rpc_url if base.rpc_url != base.chain.rpc_url else None
    )
    chain_explorer = base.chain.block_explorer.url if base.chain.block_explorer else None
    explorer_url = (overrides.explorer_url if overrides else None) or (
        base.explorer_url if base.explorer_url != chain_explorer else None
    )
    if overrides is None and not rpc_url and not explorer_url:
        return base
    asset = base.asset
    if overrides is not None and overrides.asset is not None:
        patch = (
            dataclasses.asdict(overrides.asset) if isinstance(overrides.asset, PaymentAsset) else dict(overrides.asset)
        )
        asset = dataclasses.replace(base.asset, **{k: v for k, v in patch.items() if v is not None})
    return _from_chain(
        _with_chain_overrides(base.chain, rpc_url=rpc_url, explorer_url=explorer_url),
        name=base.name,
        facilitator_url=_strip_trailing_slash(overrides.facilitator_url)
        if overrides and overrides.facilitator_url
        else base.facilitator_url,
        faucet_url=(overrides.faucet_url if overrides and overrides.faucet_url else None) or base.faucet_url,
        asset=asset,
        radius=base.radius,
        v1_names=base.v1_names,
    )


def preset_for_chain_id(chain_id: int | None) -> PaymentNetwork | None:
    """The preset whose chain id matches, if any."""
    return next((n for n in PRESET_NETWORKS if n.chain_id == chain_id), None)


def is_network_id(network: PaymentNetwork, id: str) -> bool:
    """True when ``id`` (CAIP-2, or an x402 v1 name) names ``network``."""
    return id == network.network or id in network.v1_names


_CAIP2 = re.compile(r"^eip155:([0-9]+)\Z")


def chain_id_from_caip2(network: str) -> int | None:
    """Parse a CAIP-2 ``eip155:<id>`` string to a chain id, or None."""
    m = _CAIP2.match(network)
    if not m:
        return None
    value = int(m.group(1))
    return value if value <= 2**53 - 1 else None


def explorer_tx_url(network: PaymentNetwork, tx_hash: str) -> str | None:
    """Explorer link for a settlement transaction, e.g. https://testnet.radiustech.xyz/tx/0x…"""
    return f"{network.explorer_url}/tx/{tx_hash}" if network.explorer_url else None
