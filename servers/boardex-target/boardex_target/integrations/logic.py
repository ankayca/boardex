"""Optional integration with the logic-analyzer domain.

Keeps ``boardex-target`` installable without ``boardex-logic`` while letting
composite workflows drive a logic analyzer when both servers are present in the
monorepo/venv. Every cross-package import of ``boardex_logic`` lives in this
file (one import-guard policy), and the registry comes from
``boardex_logic.backends.build_registry`` so backends are registered exactly
once — plugins included.
"""

from __future__ import annotations

from typing import Any

from boardex_core import BackendRegistry, LogicAnalyzer

_LOGIC_REGISTRY: BackendRegistry[LogicAnalyzer] | None = None


def logic_registry() -> BackendRegistry[LogicAnalyzer] | None:
    """Return a logic backend registry, or None if boardex-logic is not installed."""
    global _LOGIC_REGISTRY
    if _LOGIC_REGISTRY is not None:
        return _LOGIC_REGISTRY
    try:
        from boardex_logic.backends import build_registry
    except ImportError:
        return None
    _LOGIC_REGISTRY = build_registry()
    return _LOGIC_REGISTRY


def resolve_logic_analyzer(device_id: str) -> LogicAnalyzer | None:
    reg = logic_registry()
    if reg is None:
        return None
    try:
        return reg.resolve(device_id)
    except Exception:  # noqa: BLE001 - unknown id / backend unavailable
        return None


def match_i2c_expectations(
    transactions: list[dict[str, Any]], expectations: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Match decoded I2C transactions against expected ones.

    Returns None when boardex-logic (which owns the matcher) is not installed.
    """
    try:
        from boardex_logic.decode.i2c import match_expectations
    except ImportError:
        return None
    return match_expectations(transactions, expectations)
