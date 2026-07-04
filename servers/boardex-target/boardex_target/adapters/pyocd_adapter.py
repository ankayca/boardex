"""pyOCD adapter: flash & debug MCU targets over CMSIS-DAP / ST-Link / etc.

This is the only file (together with pyocd_ops.py) that knows pyOCD exists. The
adapter satisfies the ``TargetController`` interface; the actual pyOCD calls live
in ``pyocd_ops`` so transient and persistent sessions share identical logic.

Session awareness: if a persistent ``ManagedSession`` is open for a device, the
adapter routes operations through it (a probe can only be claimed once). This is
what lets an agent ``open_session`` then keep using the plain flash/reset/memory
tools without hitting "device busy".
"""

from __future__ import annotations

from typing import Any, Callable

from boardex_core import DeviceInfo, OperationResult, TargetController

from .. import pyocd_ops
from ..session import ManagedSession, SessionManager


class PyOcdAdapter(TargetController):
    """Wraps pyOCD to satisfy the Boardex ``TargetController`` contract."""

    backend_name = "pyocd"

    def __init__(self, sessions: SessionManager | None = None) -> None:
        # Shared with the server so transient ops can find persistent sessions.
        self._sessions = sessions

    def is_available(self) -> bool:
        return pyocd_ops.pyocd_available()

    # -- discovery ---------------------------------------------------------

    def scan(self) -> list[DeviceInfo]:
        if not self.is_available():
            return []
        from pyocd.core.helpers import ConnectHelper

        probes = ConnectHelper.get_all_connected_probes(blocking=False)
        devices: list[DeviceInfo] = []
        for probe in probes:
            uid = getattr(probe, "unique_id", None) or ""
            devices.append(
                DeviceInfo(
                    device_id=self._device_id(uid),
                    kind="debug_probe",
                    vendor=getattr(probe, "vendor_name", "") or "unknown",
                    model=getattr(probe, "product_name", None)
                    or getattr(probe, "description", "")
                    or "debug probe",
                    serial=uid or None,
                    backend=self.backend_name,
                    extra={"description": getattr(probe, "description", "")},
                )
            )
        return devices

    def probe_unique_id(self, device_id: str) -> str:
        """Expose the raw probe id so the server can open a managed session."""
        return self._probe_uid(device_id)

    # -- operations --------------------------------------------------------

    def flash(
        self,
        device_id: str,
        firmware_path: str,
        *,
        target: str | None = None,
        verify: bool = True,
        reset_after: bool = True,
    ) -> OperationResult:
        return self._run(
            device_id,
            target,
            lambda s: pyocd_ops.flash(
                s, firmware_path, verify=verify, reset_after=reset_after
            ),
        )

    def reset(
        self, device_id: str, *, target: str | None = None, halt: bool = False
    ) -> OperationResult:
        return self._run(device_id, target, lambda s: pyocd_ops.reset(s, halt=halt))

    def halt(self, device_id: str, *, target: str | None = None) -> OperationResult:
        return self._run(
            device_id,
            target,
            pyocd_ops.halt,
            connect_mode="attach",
            resume_on_disconnect=False,
        )

    def resume(self, device_id: str, *, target: str | None = None) -> OperationResult:
        return self._run(
            device_id, target, pyocd_ops.resume, connect_mode="attach"
        )

    def read_memory(
        self, device_id: str, address: int, length: int, *, target: str | None = None
    ) -> OperationResult:
        return self._run(
            device_id, target, lambda s: pyocd_ops.read_memory(s, address, length)
        )

    def write_memory(
        self,
        device_id: str,
        address: int,
        data: bytes,
        *,
        target: str | None = None,
    ) -> OperationResult:
        return self._run(
            device_id, target, lambda s: pyocd_ops.write_memory(s, address, data)
        )

    def read_log(
        self,
        device_id: str,
        *,
        target: str | None = None,
        timeout_s: float = 2.0,
        control_block_address: int | None = None,
    ) -> OperationResult:
        return self._run(
            device_id,
            target,
            lambda s: pyocd_ops.read_rtt_once(
                s, timeout_s=timeout_s, control_block_address=control_block_address
            ),
            connect_mode="attach",
        )

    # -- helpers -----------------------------------------------------------

    def _run(
        self,
        device_id: str,
        target: str | None,
        operation: Callable[[Any], OperationResult],
        *,
        connect_mode: str | None = None,
        resume_on_disconnect: bool = True,
    ) -> OperationResult:
        """Run ``operation`` against a managed session if one exists, else a
        transient one."""
        managed: ManagedSession | None = (
            self._sessions.find_by_device(device_id) if self._sessions else None
        )
        if managed is not None:
            return managed.run(operation)

        uid = self._probe_uid(device_id)
        with pyocd_ops.transient_session(
            uid,
            target=target,
            connect_mode=connect_mode,
            resume_on_disconnect=resume_on_disconnect,
        ) as session:
            return operation(session)

    @staticmethod
    def _device_id(unique_id: str) -> str:
        """Namespaced, stable id so ids never collide across backends."""
        return f"pyocd:{unique_id}" if unique_id else "pyocd:unknown"

    @staticmethod
    def _probe_uid(device_id: str) -> str:
        return device_id.split(":", 1)[1] if ":" in device_id else device_id
