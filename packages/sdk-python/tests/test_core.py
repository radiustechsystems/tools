"""Ports of the TypeScript SDK's amounts, env, schemes and networks tests."""

from __future__ import annotations

import dataclasses
from decimal import Decimal

import pytest

from radius_sdk import (
    SBC,
    SUPPORTED_SCHEMES,
    USDC_BASE,
    USDC_BASE_SEPOLIA,
    Chain,
    NativeCurrency,
    NetworkOverrides,
    base_chain,
    base_mainnet,
    base_sepolia,
    base_sepolia_chain,
    chain_id_from_caip2,
    define_payment_network,
    describe_supported_schemes,
    format_amount,
    is_network_id,
    preset_for_chain_id,
    radius_env,
    radius_mainnet,
    radius_mainnet_chain,
    radius_testnet,
    radius_testnet_chain,
    resolve_network,
    resolve_price,
    to_atomic,
)
from radius_sdk.networks import BlockExplorer, PaymentAsset


class TestToAtomic:
    def test_parses_usd_strings_into_6_decimal_units(self) -> None:
        assert to_atomic("$0.01", 6) == "10000"
        assert to_atomic("0.001", 6) == "1000"
        assert to_atomic("1", 6) == "1000000"
        assert to_atomic("0.000001", 6) == "1"
        assert to_atomic("0.05 SBC", 6) == "50000"
        assert to_atomic("USD 0.05", 6) == "50000"
        assert to_atomic(0.1, 6) == "100000"
        assert to_atomic(2, 6) == "2000000"
        assert to_atomic(Decimal("0.25"), 6) == "250000"

    def test_rejects_too_many_decimals_negatives_and_junk(self) -> None:
        with pytest.raises(ValueError, match="decimal places"):
            to_atomic("0.0000001", 6)
        for bad in ("-1", "abc", 1e-7, -1, True, float("nan"), "１"):
            with pytest.raises(ValueError):
                to_atomic(bad, 6)  # type: ignore[arg-type]


def test_format_amount() -> None:
    assert format_amount("10000", 6) == "0.01"
    assert format_amount(1_000_000, 6, "SBC") == "1 SBC"
    assert format_amount("0", 6) == "0"
    assert format_amount("1", 6) == "0.000001"
    assert format_amount(-1500, 3) == "-1.5"


def test_resolve_price_passes_atomic_objects_through_and_defaults_the_asset() -> None:
    assert resolve_price({"amount": "123"}, SBC) == {"amount": "123", "asset": SBC.address}
    other = "0x0000000000000000000000000000000000000001"
    assert resolve_price({"amount": 5, "asset": other}, SBC) == {"amount": "5", "asset": other}
    with pytest.raises(ValueError):
        resolve_price({"amount": "1.5"}, SBC)
    assert resolve_price("$0.01", SBC) == {"amount": "10000", "asset": SBC.address}


class TestRadiusEnv:
    def test_defaults_to_mainnet_and_maps_cli_compatible_variables(self) -> None:
        assert radius_env({}) == {"network": "mainnet"}
        cfg = radius_env(
            {
                "RADIUS_NETWORK": "testnet",
                "RADIUS_RPC_URL": "https://rpc.testnet.radiustech.xyz/KEY",
                "RADIUS_FACILITATOR_URL": "https://fac.example",
                "RADIUS_FACILITATOR_API_KEY": "k",
                "RADIUS_SBC_ADDRESS": "0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb",
                "RADIUS_PAY_TO": "0x1eF420190c299D4d133fE9227F780D7d5cE91BeE",
                "RADIUS_PRIVATE_KEY": "0x" + "11" * 32,
                "RADIUS_MAX_PER_REQUEST": "$0.05",
            }
        )
        assert cfg == {
            "network": "testnet",
            "rpc_url": "https://rpc.testnet.radiustech.xyz/KEY",
            "facilitator_url": "https://fac.example",
            "facilitator": {"api_key": "k"},
            "asset": {"address": "0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb"},
            "pay_to": "0x1eF420190c299D4d133fE9227F780D7d5cE91BeE",
            "signer": "0x" + "11" * 32,
            "max_per_request": "$0.05",
        }

    def test_rejects_bad_values_loudly(self) -> None:
        with pytest.raises(ValueError, match="RADIUS_NETWORK"):
            radius_env({"RADIUS_NETWORK": "devnet"})
        with pytest.raises(ValueError, match="RADIUS_PAY_TO"):
            radius_env({"RADIUS_PAY_TO": "nope"})
        with pytest.raises(ValueError, match="RADIUS_PRIVATE_KEY"):
            radius_env({"RADIUS_PRIVATE_KEY": "0x12"})

    def test_asset_address_falls_back_to_the_radius_cli_name(self) -> None:
        a = "0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb"
        b = "0x1111111111111111111111111111111111111111"
        assert radius_env({"RADIUS_SBC_ADDRESS": a})["asset"] == {"address": a}
        assert radius_env({"RADIUS_ASSET_ADDRESS": b, "RADIUS_SBC_ADDRESS": a})["asset"] == {"address": b}


def test_supported_schemes() -> None:
    assert [f"{s.scheme}@v{s.x402_version}" for s in SUPPORTED_SCHEMES] == ["exact@v2", "upto@v2", "exact@v1"]
    assert describe_supported_schemes() == "exact@v2 (permit2 or eip3009), upto@v2 (permit2), exact@v1 (eip3009)"


class TestNetworks:
    def test_chains_describe_mainnet_and_testnet(self) -> None:
        assert radius_mainnet_chain.id == 723487
        assert radius_mainnet_chain.name == "Radius Network"
        assert radius_mainnet_chain.native_currency == NativeCurrency("Radius USD", "RUSD", 18)
        assert radius_mainnet_chain.rpc_url == "https://rpc.radiustech.xyz"
        assert radius_mainnet_chain.block_explorer == BlockExplorer(
            "Radius Network Explorer", "https://network.radiustech.xyz"
        )
        assert not radius_mainnet_chain.testnet
        assert (radius_testnet_chain.id, radius_testnet_chain.rpc_url, radius_testnet_chain.testnet) == (
            72344,
            "https://rpc.testnet.radiustech.xyz",
            True,
        )

    def test_chains_are_the_source_of_truth_for_the_presets(self) -> None:
        assert radius_mainnet.chain is radius_mainnet_chain
        assert radius_testnet.chain is radius_testnet_chain
        for n in (radius_mainnet, radius_testnet):
            assert n.chain_id == n.chain.id
            assert n.network == f"eip155:{n.chain.id}"
            assert n.rpc_url == n.chain.rpc_url
            assert n.explorer_url == n.chain.block_explorer.url  # type: ignore[union-attr]
            assert n.testnet == n.chain.testnet
            assert n.radius
        assert (radius_mainnet.name, radius_mainnet.facilitator_url) == ("radius", "https://facilitator.radiustech.xyz")
        assert (radius_testnet.name, radius_testnet.facilitator_url) == (
            "radius-testnet",
            "https://facilitator.testnet.radiustech.xyz",
        )

    def test_base_presets(self) -> None:
        assert (base_chain.id, base_chain.native_currency.symbol, base_chain.rpc_url) == (
            8453,
            "ETH",
            "https://mainnet.base.org",
        )
        assert (base_sepolia_chain.id, base_sepolia_chain.testnet) == (84532, True)
        assert (
            base_mainnet.name,
            base_mainnet.network,
            base_mainnet.asset,
            base_mainnet.radius,
            base_mainnet.v1_names,
        ) == (
            "base",
            "eip155:8453",
            USDC_BASE,
            False,
            ("base",),
        )
        assert base_mainnet.facilitator_url is None and base_mainnet.faucet_url is None
        assert base_sepolia.facilitator_url == "https://x402.org/facilitator"
        assert base_sepolia.asset == USDC_BASE_SEPOLIA
        assert (USDC_BASE.name, USDC_BASE_SEPOLIA.name) == ("USD Coin", "USDC")

    def test_preset_lookup(self) -> None:
        assert preset_for_chain_id(723487) is radius_mainnet
        assert preset_for_chain_id(84532) is base_sepolia
        assert preset_for_chain_id(1) is None
        assert is_network_id(base_mainnet, "eip155:8453")
        assert is_network_id(base_mainnet, "base")
        assert not is_network_id(base_mainnet, "base-sepolia")
        assert not is_network_id(radius_mainnet, "radius")
        assert chain_id_from_caip2("eip155:72344") == 72344
        assert chain_id_from_caip2("solana:abc") is None

    def test_resolve_network_defaults_and_aliases(self) -> None:
        assert resolve_network() is radius_mainnet
        assert resolve_network("mainnet") is radius_mainnet
        assert resolve_network("radius") is radius_mainnet
        assert resolve_network("testnet") is radius_testnet
        assert resolve_network("radius-testnet") is radius_testnet
        assert resolve_network("base") is base_mainnet
        assert resolve_network("base-sepolia") is base_sepolia
        assert resolve_network(radius_testnet) is radius_testnet
        with pytest.raises(ValueError, match="unknown network 'polygon'"):
            resolve_network("polygon")

    def test_overrides_keep_fields_and_do_not_mutate_presets(self) -> None:
        n = resolve_network("base", NetworkOverrides(rpc_url="https://base.example/KEY"))
        assert (n.name, n.rpc_url, n.radius, n.v1_names, n.asset) == (
            "base",
            "https://base.example/KEY",
            False,
            ("base",),
            USDC_BASE,
        )
        n = resolve_network(
            "testnet", NetworkOverrides(rpc_url="https://rpc.testnet.radiustech.xyz/KEY/", asset={"symbol": "USDX"})
        )
        assert n.rpc_url == "https://rpc.testnet.radiustech.xyz/KEY"
        assert (n.asset.symbol, n.asset.address) == ("USDX", SBC.address)
        assert radius_testnet.asset.symbol == "SBC"
        assert radius_testnet.rpc_url == "https://rpc.testnet.radiustech.xyz"

    def test_rpc_override_reaches_the_chain(self) -> None:
        n = resolve_network(
            "testnet",
            NetworkOverrides(
                rpc_url="https://rpc.testnet.radiustech.xyz/KEY", explorer_url="https://explorer.example/"
            ),
        )
        assert n.chain is not radius_testnet_chain
        assert n.chain.rpc_url == "https://rpc.testnet.radiustech.xyz/KEY"
        assert n.chain.block_explorer == BlockExplorer("Radius Test Network Explorer", "https://explorer.example")
        assert n.explorer_url == "https://explorer.example"

    def test_replaced_preset_resyncs_its_chain(self) -> None:
        n = resolve_network(dataclasses.replace(radius_testnet, rpc_url="https://rpc.testnet.radiustech.xyz/KEY"))
        assert n.chain.rpc_url == "https://rpc.testnet.radiustech.xyz/KEY"
        assert n.rpc_url == "https://rpc.testnet.radiustech.xyz/KEY"
        assert n.chain_id == 72344

    def test_define_payment_network(self) -> None:
        asset = PaymentAsset("0x1111111111111111111111111111111111111111", "TST", 6, "Test", "1")
        chain = Chain(
            5151,
            "Dev Chain",
            NativeCurrency("Ether", "ETH", 18),
            "http://dev-rpc",
            BlockExplorer("Dev Explorer", "http://dev-explorer"),
            True,
        )
        n = define_payment_network(chain=chain, asset=asset, facilitator_url="http://fac/")
        assert n.chain is chain
        assert (
            n.name,
            n.chain_id,
            n.network,
            n.rpc_url,
            n.explorer_url,
            n.testnet,
            n.radius,
            n.v1_names,
            n.facilitator_url,
        ) == (
            "Dev Chain",
            5151,
            "eip155:5151",
            "http://dev-rpc",
            "http://dev-explorer",
            True,
            False,
            (),
            "http://fac",
        )
        o = define_payment_network(
            chain=chain, asset=asset, name="dev", rpc_url="http://other-rpc/", radius=True, v1_names=["dev"]
        )
        assert (o.name, o.rpc_url, o.radius, o.v1_names, o.facilitator_url) == (
            "dev",
            "http://other-rpc",
            True,
            ("dev",),
            None,
        )
        assert o.chain.block_explorer.name == "Dev Explorer"  # type: ignore[union-attr]
        assert chain.rpc_url == "http://dev-rpc"
        assert resolve_network({"chain": radius_mainnet_chain, "asset": SBC}).network == "eip155:723487"
        with pytest.raises(ValueError, match="asset"):
            define_payment_network(chain=chain, asset=None)  # type: ignore[arg-type]


def test_the_package_version_matches_its_metadata() -> None:
    from importlib.metadata import version

    import radius_sdk

    assert radius_sdk.__version__ == version("radius-sdk")
