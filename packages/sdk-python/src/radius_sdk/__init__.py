"""Accept and make Radius payments over x402 v2, and optionally MPP, from Python.

The Python port of the TypeScript ``radius-sdk``. Entry points:

============================  =================================================================  ==========================
Module                        What                                                               Needs
============================  =================================================================  ==========================
``radius_sdk``                networks, amounts, receipts, errors, ``radius_env``, MPP wire format   —
``radius_sdk.server``         ``radius_payments()`` Starlette handler; ``RadiusServer`` for x402's     ``radius-sdk[server]``
                              upstream middleware
``radius_sdk.starlette``      ``RadiusPaymentsMiddleware`` ASGI middleware                          ``radius-sdk[server]``
``radius_sdk.client``         ``create_radius_fetch()`` paying client, wallet helpers               ``radius-sdk[client]``
``radius_sdk.rpc`` and the    JSON-RPC client; balance, ERC-20, Permit2 and settlement actions     ``radius-sdk[client]``
actions modules
============================  =================================================================  ==========================
"""

from .amounts import AtomicAmount, Price, format_amount, resolve_price, to_atomic
from .env import radius_env
from .errors import RadiusPaymentError, RadiusPaymentErrorCode
from .mpp import MPP_RECEIPT_HEADER, MppChallenge, MppReceipt, parse_mpp_challenges, parse_mpp_receipt
from .networks import (
    NETWORK_NAMES,
    PERMIT2_ADDRESS,
    PRESET_NETWORKS,
    SBC,
    USDC_BASE,
    USDC_BASE_SEPOLIA,
    X402_EXACT_PERMIT2_PROXY,
    BlockExplorer,
    Chain,
    NativeCurrency,
    NetworkInput,
    NetworkName,
    NetworkOverrides,
    PaymentAsset,
    PaymentNetwork,
    PaymentNetworkConfig,
    base_chain,
    base_mainnet,
    base_sepolia,
    base_sepolia_chain,
    chain_id_from_caip2,
    define_payment_network,
    explorer_tx_url,
    is_network_id,
    preset_for_chain_id,
    radius_mainnet,
    radius_mainnet_chain,
    radius_testnet,
    radius_testnet_chain,
    resolve_network,
)
from .receipt import (
    PAYMENT_RESPONSE_HEADER,
    PaymentReceipt,
    decode_mpp_receipt,
    decode_payment_receipt,
    get_payment_receipt,
    parse_upto_settlement_amount,
)
from .schemes import SUPPORTED_SCHEMES, SupportedScheme, describe_supported_schemes

__version__ = "0.1.0"

__all__ = [
    "MPP_RECEIPT_HEADER",
    "NETWORK_NAMES",
    "PAYMENT_RESPONSE_HEADER",
    "PERMIT2_ADDRESS",
    "PRESET_NETWORKS",
    "SBC",
    "SUPPORTED_SCHEMES",
    "USDC_BASE",
    "USDC_BASE_SEPOLIA",
    "X402_EXACT_PERMIT2_PROXY",
    "AtomicAmount",
    "BlockExplorer",
    "Chain",
    "MppChallenge",
    "MppReceipt",
    "NativeCurrency",
    "NetworkInput",
    "NetworkName",
    "NetworkOverrides",
    "PaymentAsset",
    "PaymentNetwork",
    "PaymentNetworkConfig",
    "PaymentReceipt",
    "Price",
    "RadiusPaymentError",
    "RadiusPaymentErrorCode",
    "SupportedScheme",
    "base_chain",
    "base_mainnet",
    "base_sepolia",
    "base_sepolia_chain",
    "chain_id_from_caip2",
    "decode_mpp_receipt",
    "decode_payment_receipt",
    "define_payment_network",
    "describe_supported_schemes",
    "explorer_tx_url",
    "format_amount",
    "get_payment_receipt",
    "is_network_id",
    "parse_mpp_challenges",
    "parse_mpp_receipt",
    "parse_upto_settlement_amount",
    "preset_for_chain_id",
    "radius_env",
    "radius_mainnet",
    "radius_mainnet_chain",
    "radius_testnet",
    "radius_testnet_chain",
    "resolve_network",
    "resolve_price",
    "to_atomic",
]
