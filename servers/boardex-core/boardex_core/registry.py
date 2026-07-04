"""Backend registry: the single source of truth for what's on the bench.

Implements the Registry + Factory patterns. Servers register adapter *factories*
at startup; the registry lazily instantiates them, aggregates their ``scan()``
output into one inventory, and resolves a ``device_id`` back to its owning
adapter.
"""

from __future__ import annotations

import logging
from typing import Callable, Generic, TypeVar

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
