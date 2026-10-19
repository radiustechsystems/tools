"""Uniswap Permit2 interactions, for the canonical Permit2 contract every Radius network shares.

SignatureTransfer (what x402 uses): the owner signs a one-off ``PermitTransferFrom`` (optionally with
a witness binding extra data), and the spender submits it with ``permitTransferFrom`` /
``permitWitnessTransferFrom`` to pull the tokens. Nonces are unordered 256-bit values tracked in a
bitmap; :func:`is_permit2_nonce_used` checks one.

AllowanceTransfer (what Uniswap-style apps use): the owner signs a ``PermitSingle`` granting a
spender an amount until an expiration; the spender submits it with ``permit`` and then moves tokens
with ``transferFrom`` any number of times within the allowance.

Both need the owner to have granted Permit2 an ERC-20 allowance once (:func:`approve_permit2`,
unlimited by default, the x402 "one-time gas approval" model) unless a facilitator sponsors it.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .eip712 import TypedDataTypes, encode_typed_data_type, hash_struct, sign_typed_data
from .erc20 import (
    APPROVE,
    TokenAmount,
    TokenInput,
    TxResult,
    configured_token,
    get_allowance,
    require_account,
    resolve_token,
    send_and_wait,
    to_token_atomic,
)
from .errors import RadiusPaymentError
from .networks import PERMIT2_ADDRESS, NetworkInput
from .rpc import AbiFunction, RpcClient, WalletClient

#: Default signing window for permits without an explicit deadline (matches the x402 client cap).
PERMIT2_DEFAULT_DEADLINE_SECONDS = 600
MAX_UINT256 = 2**256 - 1
MAX_UINT160 = 2**160 - 1
MAX_UINT48 = 2**48 - 1

_PERMIT = "((address,uint256),uint256,uint256)"
_DETAILS = "(address,uint256)"
_PERMIT_SINGLE = "((address,uint160,uint48,uint48),address,uint256)"

PERMIT_TRANSFER_FROM = AbiFunction("permitTransferFrom", (_PERMIT, _DETAILS, "address", "bytes"))
PERMIT_WITNESS_TRANSFER_FROM = AbiFunction(
    "permitWitnessTransferFrom", (_PERMIT, _DETAILS, "address", "bytes32", "string", "bytes")
)
NONCE_BITMAP = AbiFunction("nonceBitmap", ("address", "uint256"), ("uint256",))
INVALIDATE_UNORDERED_NONCES = AbiFunction("invalidateUnorderedNonces", ("uint256", "uint256"))
ALLOWANCE = AbiFunction("allowance", ("address", "address", "address"), ("uint160", "uint48", "uint48"))
PERMIT = AbiFunction("permit", ("address", _PERMIT_SINGLE, "bytes"))
TRANSFER_FROM = AbiFunction("transferFrom", ("address", "address", "uint160", "address"))
DOMAIN_SEPARATOR = AbiFunction("DOMAIN_SEPARATOR", (), ("bytes32",))


def permit2_domain(chain_id: int) -> dict[str, Any]:
    """EIP-712 domain of the canonical Permit2 deployment on ``chain_id`` (no version field)."""
    return {"name": "Permit2", "chainId": chain_id, "verifyingContract": PERMIT2_ADDRESS}


TOKEN_PERMISSIONS_TYPE: list[dict[str, str]] = [
    {"name": "token", "type": "address"},
    {"name": "amount", "type": "uint256"},
]

PERMIT_TRANSFER_FROM_TYPES: dict[str, list[dict[str, str]]] = {
    "PermitTransferFrom": [
        {"name": "permitted", "type": "TokenPermissions"},
        {"name": "spender", "type": "address"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint256"},
    ],
    "TokenPermissions": TOKEN_PERMISSIONS_TYPE,
}

PERMIT_SINGLE_TYPES: dict[str, list[dict[str, str]]] = {
    "PermitSingle": [
        {"name": "details", "type": "PermitDetails"},
        {"name": "spender", "type": "address"},
        {"name": "sigDeadline", "type": "uint256"},
    ],
    "PermitDetails": [
        {"name": "token", "type": "address"},
        {"name": "amount", "type": "uint160"},
        {"name": "expiration", "type": "uint48"},
        {"name": "nonce", "type": "uint48"},
    ],
}


@dataclass(frozen=True)
class Permit2Witness:
    """Extra data a SignatureTransfer permit is bound to (e.g. x402's ``Witness(address to,uint256 validAfter)``)."""

    #: Name of the witness struct, e.g. ``Witness``.
    type_name: str
    #: EIP-712 definitions of the witness struct and anything it references.
    types: Mapping[str, Sequence[Mapping[str, str]]]
    #: The witness value.
    value: Mapping[str, Any]


@dataclass(frozen=True)
class PermitTransferFrom:
    token: str
    amount: int
    nonce: int
    deadline: int

    def as_tuple(self) -> tuple[Any, ...]:
        return ((self.token, self.amount), self.nonce, self.deadline)

    def message(self, spender: str) -> dict[str, Any]:
        return {
            "permitted": {"token": self.token, "amount": self.amount},
            "spender": spender,
            "nonce": self.nonce,
            "deadline": self.deadline,
        }


@dataclass(frozen=True)
class SignedPermit2Transfer:
    """A signed SignatureTransfer permit: everything the spender needs to call Permit2."""

    permit: PermitTransferFrom
    spender: str
    owner: str
    signature: str
    chain_id: int
    witness: Permit2Witness | None = None


@dataclass(frozen=True)
class PermitSingle:
    token: str
    amount: int
    expiration: int
    nonce: int
    spender: str
    sig_deadline: int

    def as_tuple(self) -> tuple[Any, ...]:
        return ((self.token, self.amount, self.expiration, self.nonce), self.spender, self.sig_deadline)

    def message(self) -> dict[str, Any]:
        return {
            "details": {"token": self.token, "amount": self.amount, "expiration": self.expiration, "nonce": self.nonce},
            "spender": self.spender,
            "sigDeadline": self.sig_deadline,
        }


@dataclass(frozen=True)
class SignedPermit2Allowance:
    """A signed AllowanceTransfer permit, submitted with :func:`permit2_permit`."""

    permit_single: PermitSingle
    owner: str
    signature: str
    chain_id: int


@dataclass(frozen=True)
class Permit2Allowance:
    #: Remaining allowance (uint160).
    amount: int
    #: Unix seconds after which the allowance is void (uint48).
    expiration: int
    #: Next AllowanceTransfer nonce for (owner, token, spender).
    nonce: int


def random_permit2_nonce() -> int:
    """A random unordered nonce for SignatureTransfer (256 bits)."""
    return secrets.randbits(256)


_PERMIT_WITNESS_STUB = (
    "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,"
)


def permit_witness_transfer_from_types(witness: Permit2Witness) -> dict[str, list[dict[str, str]]]:
    """The full EIP-712 types for a witnessed permit: ``PermitWitnessTransferFrom`` + ``TokenPermissions`` + the witness structs."""
    return {
        "PermitWitnessTransferFrom": [
            {"name": "permitted", "type": "TokenPermissions"},
            {"name": "spender", "type": "address"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
            {"name": "witness", "type": witness.type_name},
        ],
        "TokenPermissions": TOKEN_PERMISSIONS_TYPE,
        **{name: [dict(f) for f in fields] for name, fields in witness.types.items()},
    }


def permit2_witness_type_string(witness: Permit2Witness) -> str:
    """The ``witnessTypeString`` Permit2 expects: everything after its ``PermitWitnessTransferFrom(...,`` stub."""
    full = encode_typed_data_type("PermitWitnessTransferFrom", permit_witness_transfer_from_types(witness))
    if not full.startswith(_PERMIT_WITNESS_STUB):
        raise RadiusPaymentError("config", "permit2_witness_type_string: unexpected type encoding")
    return full[len(_PERMIT_WITNESS_STUB) :]


def permit2_witness_hash(witness: Permit2Witness) -> str:
    """``hashStruct`` of the witness value, the ``witness`` argument of ``permitWitnessTransferFrom``."""
    types: TypedDataTypes = {name: list(fields) for name, fields in witness.types.items()}
    return "0x" + hash_struct(witness.type_name, witness.value, types).hex()


def _token_address(client: RpcClient, token: TokenInput | None, what: str) -> str:
    t = resolve_token(client, token, what)
    return t if isinstance(t, str) else t.address


def _deadline(value: int | None) -> int:
    now = int(time.time())
    if value is None:
        return now + PERMIT2_DEFAULT_DEADLINE_SECONDS
    if int(value) <= now:
        raise RadiusPaymentError("config", f"Permit2 deadline {value} is in the past")
    return int(value)


# -- reads ----------------------------------------------------------------------------------------


async def get_permit2_approval(client: RpcClient, owner: str, *, token: TokenInput | None = None) -> int:
    """ERC-20 allowance the owner has granted to Permit2 (the one-time approval), in atomic units."""
    return await get_allowance(
        client, owner, PERMIT2_ADDRESS, token=resolve_token(client, token, "get_permit2_approval")
    )


async def get_permit2_allowance(
    client: RpcClient, owner: str, spender: str, *, token: TokenInput | None = None
) -> Permit2Allowance:
    """AllowanceTransfer state Permit2 holds for (owner, token, spender)."""
    amount, expiration, nonce = await client.read_contract(
        PERMIT2_ADDRESS, ALLOWANCE, owner, _token_address(client, token, "get_permit2_allowance"), spender
    )
    return Permit2Allowance(amount=int(amount), expiration=int(expiration), nonce=int(nonce))


async def is_permit2_nonce_used(client: RpcClient, owner: str, nonce: int) -> bool:
    """Whether a SignatureTransfer nonce has been consumed (or invalidated) for ``owner``."""
    bitmap = await client.read_contract(PERMIT2_ADDRESS, NONCE_BITMAP, owner, nonce >> 8)
    return bool(int(bitmap) & (1 << (nonce & 0xFF)))


# -- owner side -----------------------------------------------------------------------------------


async def approve_permit2(
    client: WalletClient, *, amount: TokenAmount | None = None, token: TokenInput | None = None, wait: bool = True
) -> TxResult:
    """ERC-20 ``approve(Permit2, amount)`` from the client's account; unlimited by default."""
    require_account(client, "approve_permit2")
    t = resolve_token(client, token, "approve_permit2")
    atomic = MAX_UINT256 if amount is None else await to_token_atomic(client, t, amount)
    address = t if isinstance(t, str) else t.address
    return await send_and_wait(client, wait, lambda: client.write_contract(address, APPROVE, PERMIT2_ADDRESS, atomic))


async def sign_permit2_transfer(
    client: WalletClient,
    amount: TokenAmount,
    spender: str,
    *,
    token: TokenInput | None = None,
    nonce: int | None = None,
    deadline: int | None = None,
    witness: Permit2Witness | None = None,
) -> SignedPermit2Transfer:
    """Sign a SignatureTransfer permit (``PermitWitnessTransferFrom`` when a witness is given). Nothing is sent on-chain."""
    account = require_account(client, "sign_permit2_transfer")
    t = resolve_token(client, token, "sign_permit2_transfer")
    atomic, chain_id = await asyncio.gather(to_token_atomic(client, t, amount), client.chain_id())
    permit = PermitTransferFrom(
        token=t if isinstance(t, str) else t.address,
        amount=atomic,
        nonce=random_permit2_nonce() if nonce is None else nonce,
        deadline=_deadline(deadline),
    )
    message = permit.message(spender)
    if witness is not None:
        signature = sign_typed_data(
            account,
            permit2_domain(chain_id),
            permit_witness_transfer_from_types(witness),
            "PermitWitnessTransferFrom",
            {**message, "witness": dict(witness.value)},
        )
    else:
        signature = sign_typed_data(
            account, permit2_domain(chain_id), PERMIT_TRANSFER_FROM_TYPES, "PermitTransferFrom", message
        )
    return SignedPermit2Transfer(
        permit=permit, spender=spender, owner=account.address, signature=signature, chain_id=chain_id, witness=witness
    )


async def sign_permit2_allowance(
    client: WalletClient,
    amount: TokenAmount,
    spender: str,
    expiration: int,
    *,
    token: TokenInput | None = None,
    sig_deadline: int | None = None,
    nonce: int | None = None,
) -> SignedPermit2Allowance:
    """Sign an AllowanceTransfer ``PermitSingle``. The nonce is read from Permit2 unless given."""
    account = require_account(client, "sign_permit2_allowance")
    t = resolve_token(client, token, "sign_permit2_allowance")
    address = t if isinstance(t, str) else t.address

    async def current_nonce() -> int:
        if nonce is not None:
            return nonce
        return (await get_permit2_allowance(client, account.address, spender, token=t)).nonce

    atomic, chain_id, n = await asyncio.gather(to_token_atomic(client, t, amount), client.chain_id(), current_nonce())
    if atomic > MAX_UINT160:
        raise RadiusPaymentError("config", f"Permit2 allowance amount {atomic} exceeds uint160")
    if not isinstance(expiration, int) or expiration < 0 or expiration > MAX_UINT48:
        raise RadiusPaymentError("config", f"Permit2 expiration must be a uint48 of unix seconds (got {expiration})")
    permit_single = PermitSingle(
        token=address,
        amount=atomic,
        expiration=expiration,
        nonce=n,
        spender=spender,
        sig_deadline=_deadline(sig_deadline),
    )
    signature = sign_typed_data(
        account, permit2_domain(chain_id), PERMIT_SINGLE_TYPES, "PermitSingle", permit_single.message()
    )
    return SignedPermit2Allowance(
        permit_single=permit_single, owner=account.address, signature=signature, chain_id=chain_id
    )


# -- spender side ---------------------------------------------------------------------------------


def _sig(signature: str) -> bytes:
    return bytes.fromhex(signature[2:] if signature.startswith("0x") else signature)


async def permit2_transfer_from(
    client: WalletClient, signed: SignedPermit2Transfer, to: str, *, amount: int | None = None, wait: bool = True
) -> TxResult:
    """Submit a signed SignatureTransfer permit, pulling ``amount`` (default: all of it) to ``to``.

    The client's account must be ``signed.spender``.
    """
    account = require_account(client, "permit2_transfer_from")
    if account.address.lower() != signed.spender.lower():
        raise RadiusPaymentError(
            "config",
            f"permit2_transfer_from must be sent by the permit's spender {signed.spender}, not {account.address}",
        )
    requested = signed.permit.amount if amount is None else amount
    if requested > signed.permit.amount:
        raise RadiusPaymentError("config", f"Requested {requested} exceeds the permitted {signed.permit.amount}")
    details = (to, requested)
    if signed.witness is not None:
        witness_hash = bytes.fromhex(permit2_witness_hash(signed.witness)[2:])
        type_string = permit2_witness_type_string(signed.witness)
        return await send_and_wait(
            client,
            wait,
            lambda: client.write_contract(
                PERMIT2_ADDRESS,
                PERMIT_WITNESS_TRANSFER_FROM,
                signed.permit.as_tuple(),
                details,
                signed.owner,
                witness_hash,
                type_string,
                _sig(signed.signature),
            ),
        )
    return await send_and_wait(
        client,
        wait,
        lambda: client.write_contract(
            PERMIT2_ADDRESS,
            PERMIT_TRANSFER_FROM,
            signed.permit.as_tuple(),
            details,
            signed.owner,
            _sig(signed.signature),
        ),
    )


async def permit2_permit(client: WalletClient, signed: SignedPermit2Allowance, *, wait: bool = True) -> TxResult:
    """Submit a signed ``PermitSingle`` so Permit2 records the allowance. Anyone may send it."""
    require_account(client, "permit2_permit")
    return await send_and_wait(
        client,
        wait,
        lambda: client.write_contract(
            PERMIT2_ADDRESS, PERMIT, signed.owner, signed.permit_single.as_tuple(), _sig(signed.signature)
        ),
    )


async def permit2_allowance_transfer_from(
    client: WalletClient,
    from_: str,
    to: str,
    amount: TokenAmount,
    *,
    token: TokenInput | None = None,
    wait: bool = True,
) -> TxResult:
    """AllowanceTransfer ``transferFrom``: move tokens within an allowance granted to the client's account."""
    require_account(client, "permit2_allowance_transfer_from")
    t = resolve_token(client, token, "permit2_allowance_transfer_from")
    atomic = await to_token_atomic(client, t, amount)
    if atomic > MAX_UINT160:
        raise RadiusPaymentError("config", f"Permit2 transfer amount {atomic} exceeds uint160")
    address = t if isinstance(t, str) else t.address
    return await send_and_wait(
        client, wait, lambda: client.write_contract(PERMIT2_ADDRESS, TRANSFER_FROM, from_, to, atomic, address)
    )


@dataclass
class Permit2Actions:
    """Permit2 actions bound to a client and a default token (viem's ``permit2Actions()`` extension)."""

    client: Any
    token: TokenInput | None = None
    network: NetworkInput | None = None
    _default: TokenInput | None = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        self._default = configured_token(self.client, self.token, self.network, "Permit2Actions")

    def _t(self, token: TokenInput | None) -> TokenInput | None:
        return token or self._default

    async def get_permit2_approval(self, owner: str, *, token: TokenInput | None = None) -> int:
        return await get_permit2_approval(self.client, owner, token=self._t(token))

    async def get_permit2_allowance(
        self, owner: str, spender: str, *, token: TokenInput | None = None
    ) -> Permit2Allowance:
        return await get_permit2_allowance(self.client, owner, spender, token=self._t(token))

    async def is_permit2_nonce_used(self, owner: str, nonce: int) -> bool:
        return await is_permit2_nonce_used(self.client, owner, nonce)

    async def approve_permit2(self, *, token: TokenInput | None = None, **kw: Any) -> TxResult:
        return await approve_permit2(self.client, token=self._t(token), **kw)

    async def sign_permit2_transfer(
        self, amount: TokenAmount, spender: str, *, token: TokenInput | None = None, **kw: Any
    ) -> SignedPermit2Transfer:
        return await sign_permit2_transfer(self.client, amount, spender, token=self._t(token), **kw)

    async def sign_permit2_allowance(
        self, amount: TokenAmount, spender: str, expiration: int, *, token: TokenInput | None = None, **kw: Any
    ) -> SignedPermit2Allowance:
        return await sign_permit2_allowance(self.client, amount, spender, expiration, token=self._t(token), **kw)

    async def permit2_transfer_from(self, signed: SignedPermit2Transfer, to: str, **kw: Any) -> TxResult:
        return await permit2_transfer_from(self.client, signed, to, **kw)

    async def permit2_permit(self, signed: SignedPermit2Allowance, **kw: Any) -> TxResult:
        return await permit2_permit(self.client, signed, **kw)

    async def permit2_allowance_transfer_from(
        self, from_: str, to: str, amount: TokenAmount, *, token: TokenInput | None = None, **kw: Any
    ) -> TxResult:
        return await permit2_allowance_transfer_from(self.client, from_, to, amount, token=self._t(token), **kw)
