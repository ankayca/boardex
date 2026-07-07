"""Backend registry: the single source of truth for what's on the bench.

Implements the Registry + Factory patterns. Servers register adapter *factories*
at startup; the registry lazily instantiates them, aggregates their ``scan()``
output into one inventory, and resolves a ``device_id`` back to its owning
adapter.

Backends can also be discovered as *plugins* via Python entry points
(``load_plugins``), so third-party adapter packages appear on the bench simply
by being pip-installed — no Boardex server code changes required.
"""

from __future__ import annotations

import inspect
import logging
from importlib.metadata import entry_points
from typing import Any, Callable, Generic, TypeVar

from .errors import DeviceNotFoundError
from .interfaces import Backend, DeviceInfo

log = logging.getLogger(__name__)

B = TypeVar("B", bound=Backend)


class BackendRegistry(Generic[B]):
    """Holds backend adapters for a single capability domain.

    Generic over the backend type so a ``BackendRegistry[TargetController]`` only
    accepts target controllers, giving type checkers something to bite on.
    """

    def __init__(self) -> None:
        self._factories: dict[str, Callable[[], B]] = {}
        self._instances: dict[str, B] = {}
        # device_id -> backend_name, refreshed on every scan().
        self._owner: dict[str, str] = {}

    def register(self, name: str, factory: Callable[[], B]) -> None:
        """Register an adapter factory under ``name`` (lazily instantiated)."""
        self._factories[name] = factory

    def registered_backends(self) -> list[str]:
        """Names of every registered backend (healthy or not)."""
        return list(self._factories)

    def load_plugins(
        self, group: str, *, context: dict[str, Any] | None = None
    ) -> list[str]:
        """Discover backend adapters published as entry points in ``group``.

        Each entry point must resolve to a callable (usually the adapter class)
        returning a ``Backend``. ``context`` carries shared server objects (e.g.
        a session manager); only the keyword arguments the plugin's callable
        actually declares are passed, so simple adapters can ignore it entirely.

        A plugin that fails to import is logged and skipped — one broken
        third-party package must never take the whole bench down. Returns the
        names of the plugins that were registered.
        """
        loaded: list[str] = []
        for ep in entry_points(group=group):
            if ep.name in self._factories:
                log.warning(
                    "backend plugin %r already registered; skipping duplicate from %s",
                    ep.name,
                    ep.value,
                )
                continue
            try:
                obj = ep.load()
            except Exception as exc:  # noqa: BLE001 - plugin quality is unknown
                log.warning("failed to load backend plugin %r (%s): %s", ep.name, ep.value, exc)
                continue
            self._factories[ep.name] = self._plugin_factory(obj, context or {})
            loaded.append(ep.name)
        return loaded

    @staticmethod
    def _plugin_factory(obj: Callable[..., B], context: dict[str, Any]) -> Callable[[], B]:
        """Wrap a plugin callable, injecting only the context kwargs it accepts."""

        def factory() -> B:
            kwargs: dict[str, Any] = {}
            try:
                params = inspect.signature(obj).parameters
            except (TypeError, ValueError):
                params = {}
            accepts_var_kwargs = any(
                p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()
            )
            for key, value in context.items():
                if accepts_var_kwargs or key in params:
                    kwargs[key] = value
            return obj(**kwargs)

        return factory

    def _instance(self, name: str) -> B:
        if name not in self._instances:
            self._instances[name] = self._factories[name]()
        return self._instances[name]

    def available_backends(self) -> list[str]:
        """Names of registered backends whose tooling is actually installed."""
        healthy: list[str] = []
        for name in self._factories:
            try:
                if self._instance(name).is_available():
                    healthy.append(name)
            except Exception as exc:  # noqa: BLE001 - one bad backend must not kill the rest
                log.warning("backend %s failed availability check: %s", name, exc)
        return healthy

    def scan(self) -> list[DeviceInfo]:
        """Aggregate device discovery across every healthy backend.

        A failure in one backend is logged and skipped so the rest of the bench
        stays usable (fault isolation).
        """
        devices: list[DeviceInfo] = []
        self._owner.clear()
        for name in self._factories:
            try:
                backend = self._instance(name)
                if not backend.is_available():
                    continue
                for dev in backend.scan():
                    self._owner[dev.device_id] = name
                    devices.append(dev)
            except Exception as exc:  # noqa: BLE001
                log.warning("scan failed for backend %s: %s", name, exc)
        return devices

    def resolve(self, device_id: str) -> B:
        """Return the adapter that owns ``device_id``.

        Refreshes the inventory first if the id is unknown, so agents don't have
        to call a scan tool before every operation.
        """
        if device_id not in self._owner:
            self.scan()
        if device_id not in self._owner:
            known = ", ".join(sorted(self._owner)) or "<none>"
            raise DeviceNotFoundError(
                f"No device with id '{device_id}'. Known devices: {known}."
            )
        return self._instance(self._owner[device_id])
