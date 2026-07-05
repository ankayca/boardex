"""Parse libsigrokdecode I2C annotation streams into structured transactions.

Sigrok emits one annotation per protocol event (START, ADDRESS, DATA, ACK/NACK).
This module folds them into records an agent can assert against directly::

    {"addr_7bit": 0x77, "rw": "w", "write": [0xD0], "read": [], "nack_at": null}
"""

from __future__ import annotations

import re
from typing import Any

_ADDR_RE = re.compile(
    r"^ADDRESS\s+(READ|WRITE):\s*([0-9A-Fa-f]{1,2})\s*(ACK|NACK)?$",
    re.IGNORECASE,
)
_DATA_RE = re.compile(
    r"^DATA\s+(READ|WRITE)?:?\s*([0-9A-Fa-f]{1,2})\s*(ACK|NACK)?$",
    re.IGNORECASE,
)
_ACK_RE = re.compile(r"^(ACK|NACK)$", re.IGNORECASE)


def _hex_byte(token: str) -> int:
    return int(token, 16)


def _addr_7bit(addr_byte: int) -> int:
    return addr_byte >> 1


def _new_transaction() -> dict[str, Any]:
    return {
        "addr_7bit": None,
        "rw": None,
        "write": [],
        "read": [],
        "nack_at": None,
        "events": [],
    }


def _finalize(transactions: list[dict[str, Any]], current: dict[str, Any] | None) -> None:
    if current is None:
        return
    if current["addr_7bit"] is not None or current["write"] or current["read"]:
        transactions.append(
            {
                "addr_7bit": current["addr_7bit"],
                "rw": current["rw"],
                "write": list(current["write"]),
                "read": list(current["read"]),
                "nack_at": current["nack_at"],
            }
        )


def parse_transactions(annotations: list[dict]) -> list[dict[str, Any]]:
    """Fold sigrok I2C annotations into transaction dicts."""
    transactions: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    phase: str | None = None  # "write" | "read" after address

    for ann in annotations:
        text = (ann.get("text") or "").strip()
        if not text:
            continue
        upper = text.upper()

        if upper in ("START", "START REPEAT", "REPEATED START", "RESTART"):
            if upper != "START" and current is not None:
                # Repeated start begins a new segment; keep prior if populated.
                _finalize(transactions, current)
            current = _new_transaction()
            current["events"].append(text)
            phase = None
            continue

        if upper == "STOP":
            if current is not None:
                current["events"].append(text)
                _finalize(transactions, current)
                current = None
            phase = None
            continue

        if current is None:
            current = _new_transaction()

        m = _ADDR_RE.match(text)
        if m:
            rw_raw, addr_hex, ack = m.groups()
            addr_byte = _hex_byte(addr_hex)
            current["addr_7bit"] = _addr_7bit(addr_byte)
            current["rw"] = "r" if rw_raw.upper() == "READ" else "w"
            phase = current["rw"]
            current["events"].append(text)
            if ack and ack.upper() == "NACK":
                current["nack_at"] = "address"
            continue

        m = _DATA_RE.match(text)
        if m:
            rw_hint, data_hex, ack = m.groups()
            value = _hex_byte(data_hex)
            bucket = "read" if (rw_hint or "").upper() == "READ" or phase == "r" else "write"
            current[bucket].append(value)
            current["events"].append(text)
            if ack and ack.upper() == "NACK" and current["nack_at"] is None:
                current["nack_at"] = "data"
            continue

        if _ACK_RE.match(text):
            current["events"].append(text)
            continue

        # Fallback: bare "DATA: XX" or "READ/WRITE DATA: XX" variants.
        if text.upper().startswith("DATA"):
            parts = text.split(":")
            if len(parts) == 2:
                value = _hex_byte(parts[1].strip().split()[0])
                bucket = "read" if phase == "r" else "write"
                current[bucket].append(value)
                current["events"].append(text)

    _finalize(transactions, current)
    return transactions


def match_expectations(
    transactions: list[dict[str, Any]],
    expectations: list[dict[str, Any]],
) -> dict[str, Any]:
    """Check decoded transactions against expected I2C traffic.

    Each expectation may include ``addr_7bit``, ``rw`` (``"r"``/``"w"``),
    ``write`` (list of bytes), and ``read`` (list of bytes). Returns
    ``matched``, ``matched_count``, and ``failures`` with human-readable reasons.
    """
    failures: list[str] = []
    matched_count = 0

    for i, expect in enumerate(expectations):
        if i >= len(transactions):
            failures.append(f"expectation[{i}]: no transaction (capture too short?)")
            continue
        tx = transactions[i]
        addr = expect.get("addr_7bit")
        if addr is not None and tx.get("addr_7bit") != addr:
            failures.append(
                f"expectation[{i}]: addr_7bit want {addr:#04x}, got {tx.get('addr_7bit')!r}"
            )
            continue
        rw = expect.get("rw")
        if rw is not None and tx.get("rw") != rw:
            failures.append(f"expectation[{i}]: rw want {rw!r}, got {tx.get('rw')!r}")
            continue
        for key in ("write", "read"):
            if key not in expect:
                continue
            want = expect[key]
            got = tx.get(key, [])
            if list(want) != list(got):
                failures.append(
                    f"expectation[{i}]: {key} want {[f'{b:#04x}' for b in want]}, "
                    f"got {[f'{b:#04x}' for b in got]}"
                )
                break
        else:
            matched_count += 1

    return {
        "matched": not failures and matched_count == len(expectations),
        "matched_count": matched_count,
        "expected_count": len(expectations),
        "failures": failures,
    }
