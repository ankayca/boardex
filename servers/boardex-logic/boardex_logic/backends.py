"""Canonical registry assembly for logic-analyzer backends.

Backends are discovered as plugins via the ``boardex.logic_backends`` entry
point group, so a third-party analyzer adapter (Saleae SDK, vendor CLI, ...)
joins the bench simply by being pip-installed. The built-in sigrok adapter is
published through the same mechanism (see this package's ``pyproject.toml``);
a direct fallback registration keeps checkouts with stale entry-point metadata
working.

This is also the single place other domains (e.g. ``boardex-target``'s
cross-domain workflows) obtain a logic registry, so every backend is registered
exactly once.
"""

from __future__ import annotations

from boardex_core import BackendRegistry, LogicAnalyzer

PLUGIN_GROUP = "boardex.logic_backends"


def build_registry() -> BackendRegistry[LogicAnalyzer]:
    """Build the logic-analyzer registry from installed plugins."""
    registry: BackendRegistry[LogicAnalyzer] = BackendRegistry()
    registry.load_plugins(PLUGIN_GROUP)
    if "sigrok" not in registry.registered_backends():
        from .adapters.sigrok_adapter import SigrokAdapter

        registry.register("sigrok", SigrokAdapter)
    return registry
