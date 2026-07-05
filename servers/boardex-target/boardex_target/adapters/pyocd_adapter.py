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
from ..elf import ElfInfo
from ..session import ManagedSession, SessionManager


class PyOcdAdapter(TargetController):
    """Wraps pyOCD to satisfy the Boardex ``TargetController`` contract."""

    backend_name = "pyocd"

    def __init__(self, sessions: SessionManager | None = None) -> None:
        # Shared with the server so transient ops can find persistent sessions.
        self._sessions = sessions
        # Remember the last image flashed to each device so status/RTT tools can
        # source-map addresses and auto-locate RTT without the agent re-passing
        # the path every call.
        self._last_elf: dict[str, str] = {}

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
        result = self._run(
            device_id,
            target,
            lambda s: pyocd_ops.flash(
                s, firmware_path, verify=verify, reset_after=reset_after
            ),
        )
        if result.ok and firmware_path.lower().endswith((".elf", ".out", ".axf")):
            self._last_elf[device_id] = firmware_path
        if result.ok:
            self._drain_session_rtt(device_id, result)
        return result

    def reset(
        self, device_id: str, *, target: str | None = None, halt: bool = False
    ) -> OperationResult:
        result = self._run(device_id, target, lambda s: pyocd_ops.reset(s, halt=halt))
        if result.ok:
            self._drain_session_rtt(device_id, result)
        return result

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

    def inspect_peripheral(
        self,
        device_id: str,
        peripheral: str,
        *,
        target: str | None = None,
    ) -> OperationResult:
        from ..peripherals import inspect as peripheral_inspect

        def _read(session: Any) -> OperationResult:
            def read_block(address: int, length: int) -> bytes:
                return bytes(session.target.read_memory_block8(address, length))

            return peripheral_inspect.inspect(read_block, peripheral)

        return self._run(device_id, target, _read, connect_mode="attach")

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
        elf_path: str | None = None,
    ) -> OperationResult:
        if control_block_address is None:
            control_block_address = self.rtt_control_block(device_id, elf_path)
        return self._run(
            device_id,
            target,
            lambda s: pyocd_ops.read_rtt_once(
                s, timeout_s=timeout_s, control_block_address=control_block_address
            ),
            connect_mode="attach",
        )

    def recover(
        self,
        device_id: str,
        *,
        target: str | None = None,
        mass_erase: bool = True,
    ) -> OperationResult:
        # Recovery deliberately bypasses any managed session: a wedged board's
        # session is dead weight, and connect-under-reset needs a *fresh* connect
        # (the reset line is asserted during attach). If a session is holding the
        # probe, the resulting busy error tells the agent to close it first.
        managed = (
            self._sessions.find_by_device(device_id) if self._sessions else None
        )
        if managed is not None:
            return OperationResult.errored(
                f"A debug session ({managed.session_id}) is holding {device_id}. "
                "Close it before recovering (connect-under-reset needs the probe).",
            )
        uid = self._probe_uid(device_id)
        with pyocd_ops.transient_session(
            uid,
            target=target,
            connect_mode="under-reset",
            resume_on_disconnect=False,
        ) as session:
            return pyocd_ops.recover(session, mass_erase=mass_erase)

    def get_status(
        self,
        device_id: str,
        *,
        target: str | None = None,
        elf_path: str | None = None,
        halt: bool = False,
    ) -> OperationResult:
        elf = self._elf_for(device_id, elf_path)
        # attach mode: never perturb a running/crashed core unless halt=True is
        # explicitly requested (to recover the faulting frame in this connection).
        return self._run(
            device_id,
            target,
            lambda s: pyocd_ops.read_core_status(s, elf=elf, halt=halt),
            connect_mode="attach",
            resume_on_disconnect=False,
        )

    # -- ELF / symbol awareness -------------------------------------------

    def known_elf(self, device_id: str) -> str | None:
        """Path of the last ELF flashed to this device, if any."""
        return self._last_elf.get(device_id)

    def _elf_for(self, device_id: str, elf_path: str | None) -> ElfInfo | None:
        return ElfInfo.load(elf_path or self._last_elf.get(device_id))

    def rtt_control_block(
        self, device_id: str, elf_path: str | None = None
    ) -> int | None:
        """Resolve the ``_SEGGER_RTT`` control-block address from the ELF."""
        elf = self._elf_for(device_id, elf_path)
        return elf.symbol_address("_SEGGER_RTT") if elf is not None else None

    # -- helpers -----------------------------------------------------------

    def _drain_session_rtt(self, device_id: str, result: OperationResult) -> None:
        """Discard stale RTT backlog after a successful flash/reset.

        The background RTT logger keeps running across a reflash, so output from
        the *previous* image is still buffered when the new one boots. Dropping
        it here means a subsequent ``wait_for_rtt`` matches only fresh output and
        can't false-positive on a stale banner/result line. No-op when no session
        (or no RTT stream) is open. The count is surfaced for observability.
        """
        managed = (
            self._sessions.find_by_device(device_id) if self._sessions else None
        )
        if managed is None:
            return
        dropped = managed.mark_fresh_run()
        result.data["rtt_backlog_discarded"] = dropped
        result.data["run_epoch"] = managed._run_epoch

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
