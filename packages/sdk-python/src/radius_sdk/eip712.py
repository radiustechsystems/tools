"""EIP-712 type encoding, struct hashing and signing, for the Permit2 helpers and MPP credentials."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any, Protocol, runtime_checkable

from eth_utils import keccak

TypedDataTypes = Mapping[str, Sequence[Mapping[str, str]]]
"""EIP-712 struct definitions: ``{"Struct": [{"name": "field", "type": "uint256"}, ...]}``."""

_ARRAY = re.compile(r"^(.*)\[([0-9]*)\]$")


def encode_typed_data_type(primary_type: str, types: TypedDataTypes) -> str:
    """EIP-712 ``encodeType``: the primary type's fields, then every referenced struct sorted by name."""
    deps: list[str] = []

    def visit(name: str) -> None:
        if name in deps or name not in types:
            return
        deps.append(name)
        for f in types[name]:
            visit(re.sub(r"\[.*\]$", "", f["type"]))

    visit(primary_type)
    deps.remove(primary_type)

    def encode(name: str) -> str:
        return name + "(" + ",".join(f["type"] + " " + f["name"] for f in types[name]) + ")"

    return encode(primary_type) + "".join(encode(d) for d in sorted(deps))


def type_hash(primary_type: str, types: TypedDataTypes) -> bytes:
    return keccak(text=encode_typed_data_type(primary_type, types))


def _bytes(value: Any) -> bytes:
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, str):
        return bytes.fromhex(value[2:] if value.startswith("0x") else value)
    raise TypeError(f"expected bytes or hex, got {type(value).__name__}")


def _encode_value(type_: str, value: Any, types: TypedDataTypes) -> bytes:
    from eth_abi import encode

    if type_ in types:
        return hash_struct(type_, value, types)
    m = _ARRAY.match(type_)
    if m:
        return keccak(b"".join(_encode_value(m.group(1), v, types) for v in value))
    if type_ == "string":
        return keccak(text=value)
    if type_ == "bytes":
        return keccak(_bytes(value))
    if type_.startswith("bytes"):
        return encode([type_], [_bytes(value)])
    if type_.startswith(("uint", "int")):
        return encode([type_], [int(value)])
    return encode([type_], [value])


def hash_struct(primary_type: str, data: Mapping[str, Any], types: TypedDataTypes) -> bytes:
    """EIP-712 ``hashStruct`` of ``data`` as ``primary_type``."""
    fields = types[primary_type]
    return keccak(
        type_hash(primary_type, types) + b"".join(_encode_value(f["type"], data[f["name"]], types) for f in fields)
    )


@runtime_checkable
class TypedDataSigner(Protocol):
    """Anything that signs EIP-712 typed data, in x402's ``ClientEvmSigner`` shape."""

    @property
    def address(self) -> str: ...

    def sign_typed_data(self, domain: Any, types: Any, primary_type: str, message: dict[str, Any]) -> bytes: ...


class AccountSigner:
    """An eth-account ``LocalAccount`` as a :class:`TypedDataSigner` that can also sign messages and transactions."""

    def __init__(self, account: Any) -> None:
        self.account = account

    @property
    def address(self) -> str:
        return self.account.address

    def sign_typed_data(self, domain: Any, types: Any, primary_type: str, message: dict[str, Any]) -> bytes:
        domain_dict = domain if isinstance(domain, dict) else _domain_dict(domain)
        message_types = {
            name: [_field_dict(f) for f in fields] for name, fields in dict(types).items() if name != "EIP712Domain"
        }
        signed = self.account.sign_typed_data(
            domain_data=domain_dict, message_types=message_types, message_data=message
        )
        return bytes(signed.signature)

    def sign_message(self, text: str) -> str:
        """EIP-191 ``personal_sign`` of ``text``."""
        from eth_account.messages import encode_defunct

        return "0x" + bytes(self.account.sign_message(encode_defunct(text=text)).signature).hex()

    def sign_transaction(self, tx: dict[str, Any]) -> str:
        signed = self.account.sign_transaction(tx)
        raw = signed.raw_transaction if hasattr(signed, "raw_transaction") else signed.rawTransaction
        return "0x" + bytes(raw).hex()


def _field_dict(f: Any) -> dict[str, str]:
    if isinstance(f, Mapping):
        return {"name": f["name"], "type": f["type"]}
    return {"name": f.name, "type": f.type}


def _domain_dict(domain: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, attr in (
        ("name", "name"),
        ("version", "version"),
        ("chainId", "chain_id"),
        ("verifyingContract", "verifying_contract"),
    ):
        v = getattr(domain, attr, None)
        if v is not None:
            out[key] = v
    return out


def to_signer(signer: Any) -> Any:
    """A :class:`TypedDataSigner` from a private key, an eth-account ``LocalAccount``, or a signer object."""
    if isinstance(signer, str):
        from eth_account import Account

        return AccountSigner(Account.from_key(signer))
    if hasattr(signer, "sign_transaction") and hasattr(signer, "key") and hasattr(signer, "address"):
        return AccountSigner(signer)  # a LocalAccount
    if isinstance(signer, TypedDataSigner):
        return signer
    raise TypeError(
        "signer must be a private key, an eth-account LocalAccount, or an object with address + sign_typed_data"
    )


def sign_typed_data(
    signer: Any, domain: Mapping[str, Any], types: TypedDataTypes, primary_type: str, message: dict[str, Any]
) -> str:
    """Sign typed data with any supported signer; returns the 0x-hex signature."""
    s = to_signer(signer)
    if isinstance(s, AccountSigner):
        sig = s.sign_typed_data(dict(domain), types, primary_type, message)
    else:
        from x402.mechanisms.evm.types import TypedDataField

        fields = {name: [TypedDataField(name=f["name"], type=f["type"]) for f in fs] for name, fs in types.items()}
        sig = s.sign_typed_data(dict(domain), fields, primary_type, message)
    return "0x" + bytes(sig).hex()
