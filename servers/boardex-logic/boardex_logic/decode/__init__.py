"""Structured bus decoders built on top of raw protocol annotations.

Each module turns backend-specific annotation text (sigrok today; others later)
into agent-actionable transaction records. Pure functions only — no hardware.
"""

from __future__ import annotations

from typing import Any

from . import i2c as i2c_decoder

_DECODERS: dict[str, Any] = {
    "i2c": i2c_decoder.parse_transactions,
}


def decode_transactions(protocol: str, annotations: list[dict]) -> list[dict[str, Any]]:
    """Parse ``annotations`` into structured transactions for ``protocol``."""
    fn = _DECODERS.get(protocol.lower())
    if fn is None:
        return []
    return fn(annotations)
