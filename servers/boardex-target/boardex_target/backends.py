"""Canonical registry assembly for target-control backends.

Backends are discovered as plugins via the ``boardex.target_backends`` entry
point group, so a third-party probe adapter (J-Link, OpenOCD, vendor CLI, ...)
joins the bench simply by being pip-installed. The built-in pyOCD adapter is
published through the same mechanism (see this package's ``pyproject.toml``);
a direct fallback registration keeps checkouts with stale entry-point metadata
working.
"""

from __future__ import annotations

from boardex_core import BackendRegistry, TargetController

from .session import SessionManager

PLUGIN_GROUP = "boardex.target_backends"


def build_registry(
    sessions: SessionManager | None = None,
) -> BackendRegistry[TargetController]:
    """Build the target-backend registry from installed plugins.

    ``sessions`` is offered to every plugin whose factory declares a
    ``sessions`` keyword, so session-capable adapters can route stateless
    operations through open persistent sessions.
    """
    registry: BackendRegistry[TargetController] = BackendRegistry()
    registry.load_plugins(PLUGIN_GROUP, context={"sessions": sessions})
    if "pyocd" not in registry.registered_backends():
        from .adapters.pyocd_adapter import PyOcdAdapter

        registry.register("pyocd", lambda: PyOcdAdapter(sessions))
    return registry
