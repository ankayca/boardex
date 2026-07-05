"""Optional integration with the logic-analyzer domain.

Keeps ``boardex-target`` installable without ``boardex-logic`` while letting
composite workflows drive a logic analyzer when both servers are present in the
monorepo/venv.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from boardex_core import BackendRegistry, LogicAnalyzer

if TYPE_CHECKING:
    pass

_LOGIC_REGISTRY: BackendRegistry[LogicAnalyzer] | None = None


def logic_registry() -> BackendRegistry[LogicAnalyzer] | None:
    """Return a logic backend registry, or None if boardex-logic is not installed."""
    global _LOGIC_REGISTRY
    if _LOGIC_REGISTRY is not None:
        return _LOGIC_REGISTRY
    try:
        from boardex_logic.adapters.sigrok_adapter import SigrokAdapter
    except ImportError:
        return None
    reg: BackendRegistry[LogicAnalyzer] = BackendRegistry()
    reg.register("sigrok", SigrokAdapter)
    _LOGIC_REGISTRY = reg
    return reg


def resolve_logic_analyzer(device_id: str) -> LogicAnalyzer | None:
    reg = logic_registry()
    if reg is None:
        return None
    try:
        return reg.resolve(device_id)
    except Exception:  # noqa: BLE001 - unknown id / backend unavailable
        return None
