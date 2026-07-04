"""pyOCD adapter: flash & debug MCU targets over CMSIS-DAP / ST-Link / etc.

This is the only file in ``boardex-target`` that knows pyOCD exists. All vendor
quirks live here, quarantined behind the ``TargetController`` interface so the
MCP tools stay backend-agnostic.

Design notes:
- **Stateless sessions.** Each operation opens a fresh pyOCD session, does its
  work, and closes it. This avoids stuck/locked debug sessions, which are the
  most common cause of a flaky bench. Persistent debug sessions (for stepping,
  breakpoints) are a deliberate Phase 2 feature.
- **Graceful availability.** pyOCD is imported lazily so the server can start and
  report a clean error even when the dependency is missing.
"""

from __future__ import annotations

import contextlib
import time
from typing import Any, Iterator

from boardex_core import (
    DeviceBusyError,
    DeviceInfo,
    DeviceNotFoundError,
    OperationFailedError,
    OperationResult,
    TargetController,
)

try:  # pyOCD is optional at import time; is_available() reports the truth.
    from pyocd.core.helpers import ConnectHelper
    from pyocd.flash.file_programmer import FileProgrammer

    _PYOCD_IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001
    ConnectHelper = None  # type: ignore[assignment]
    FileProgrammer = None  # type: ignore[assignment]
    _PYOCD_IMPORT_ERROR = exc


class PyOcdAdapter(TargetController):
    """Wraps pyOCD to satisfy the Boardex ``TargetController`` contract."""

    backend_name = "pyocd"

    def is_available(self) -> bool:
        return _PYOCD_IMPORT_ERROR is None

    # -- discovery ---------------------------------------------------------

    def scan(self) -> list[DeviceInfo]:
        if not self.is_available():
            return []
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
        started = time.monotonic()
        with self._session(device_id, target=target) as session:
            programmer = FileProgrammer(session)
            # pyOCD auto-detects .elf/.hex/.bin by extension.
            programmer.program(firmware_path)
            if reset_after:
                session.target.reset()
        result = OperationResult.passed(
            f"Flashed '{firmware_path}' to {device_id}.",
            firmware_path=firmware_path,
            verified=verify,
            reset_after=reset_after,
        )
        result.duration_s = round(time.monotonic() - started, 3)
        return result

    def reset(
        self, device_id: str, *, target: str | None = None, halt: bool = False
    ) -> OperationResult:
        with self._session(device_id, target=target) as session:
            if halt:
                session.target.reset_and_halt()
            else:
                session.target.reset()
        state = "reset and halted" if halt else "reset"
        return OperationResult.passed(f"Target {device_id} {state}.", halted=halt)

    def halt(self, device_id: str, *, target: str | None = None) -> OperationResult:
        # connect_mode="attach" avoids an implicit halt-on-connect; we then halt
        # explicitly and keep the core halted after the session closes.
        with self._session(
            device_id,
            target=target,
            connect_mode="attach",
            resume_on_disconnect=False,
        ) as session:
            session.target.halt()
        return OperationResult.passed(f"Target {device_id} halted.")

    def resume(self, device_id: str, *, target: str | None = None) -> OperationResult:
        with self._session(
            device_id, target=target, connect_mode="attach"
        ) as session:
            session.target.resume()
        return OperationResult.passed(f"Target {device_id} resumed.")

    def read_memory(
        self, device_id: str, address: int, length: int, *, target: str | None = None
    ) -> OperationResult:
        with self._session(device_id, target=target) as session:
            data = bytes(session.target.read_memory_block8(address, length))
        return OperationResult.passed(
            f"Read {length} bytes @ {address:#010x} from {device_id}.",
            address=address,
            length=length,
            hex=data.hex(),
        )

    def write_memory(
        self,
        device_id: str,
        address: int,
        data: bytes,
        *,
        target: str | None = None,
    ) -> OperationResult:
        with self._session(device_id, target=target) as session:
            session.target.write_memory_block8(address, list(data))
        return OperationResult.passed(
            f"Wrote {len(data)} bytes @ {address:#010x} to {device_id}.",
            address=address,
            length=len(data),
        )

    def read_log(
        self, device_id: str, *, target: str | None = None, timeout_s: float = 2.0
    ) -> OperationResult:
        # RTT/semihosting capture is Phase 1.5. The Verdict system lets us return
        # a clean, machine-readable "not judged yet" instead of a fake success.
        return OperationResult.inconclusive(
            "Firmware log capture (RTT/semihosting) is not wired up on the pyOCD "
            "backend yet. Use flash + read_memory for now; RTT is next.",
            device_id=device_id,
        )

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _device_id(unique_id: str) -> str:
        """Namespaced, stable id so ids never collide across backends."""
        return f"pyocd:{unique_id}" if unique_id else "pyocd:unknown"

    @staticmethod
    def _probe_uid(device_id: str) -> str:
        return device_id.split(":", 1)[1] if ":" in device_id else device_id

    @contextlib.contextmanager
    def _session(
        self,
        device_id: str,
        *,
        target: str | None = None,
        connect_mode: str | None = None,
        resume_on_disconnect: bool = True,
    ) -> Iterator[Any]:
        """Open a pyOCD session for ``device_id`` and translate its errors.

        Any pyOCD failure is converted into a typed ``BoardexError`` so the MCP
        facade can render an actionable ``verdict="error"`` result.
        """
        if not self.is_available():
            raise OperationFailedError(
                f"pyOCD is not importable: {_PYOCD_IMPORT_ERROR}"
            )

        options: dict[str, Any] = {"resume_on_disconnect": resume_on_disconnect}
        if connect_mode is not None:
            options["connect_mode"] = connect_mode

        try:
            session = ConnectHelper.session_with_chosen_probe(
                unique_id=self._probe_uid(device_id),
                target_override=target,
                options=options,
                blocking=False,
            )
        except Exception as exc:  # noqa: BLE001
            raise OperationFailedError(f"Could not open probe session: {exc}") from exc

        if session is None:
            raise DeviceNotFoundError(
                f"No debug probe matched '{device_id}'. Is it plugged in?"
            )

        try:
            with session:
                yield session
        except DeviceNotFoundError:
            raise
        except Exception as exc:  # noqa: BLE001
            message = str(exc).lower()
            if "busy" in message or "in use" in message or "locked" in message:
                raise DeviceBusyError(
                    f"Probe {device_id} is busy (another tool holding it?): {exc}"
                ) from exc
            raise OperationFailedError(str(exc)) from exc
