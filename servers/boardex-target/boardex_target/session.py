"""Persistent debug sessions with a background RTT logger.

A ``ManagedSession`` keeps one pyOCD session open so the agent can flash, then
stream firmware logs, then flash again without re-claiming the probe each time.

Concurrency model: a single probe/DAP is *not* thread-safe, so every access to a
session's target is serialised by one lock. The background RTT reader thread
acquires that same lock for each poll, and drops what it reads into a separate,
independently-locked ring buffer that ``read_rtt`` drains.

Backend note: session creation currently assumes the pyOCD backend (the only
target backend today). When a second backend (e.g. J-Link) is added, session
creation should move behind the adapter interface.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable

from boardex_core import DeviceBusyError, DeviceNotFoundError, OperationResult

from . import pyocd_ops


class _RttLogger:
    """Background thread that continuously drains one RTT up channel."""

    def __init__(
        self,
        session: Any,
        lock: threading.RLock,
        *,
        control_block_address: int | None = None,
        poll_interval_s: float = 0.05,
        max_buffer_bytes: int = 1_000_000,
    ) -> None:
        self._session = session
        self._target_lock = lock
        self._control_block_address = control_block_address
        self._poll_interval_s = poll_interval_s
        self._max_buffer_bytes = max_buffer_bytes

        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

        self._buffer_lock = threading.Lock()
        self._buffer = bytearray()
        self._total_bytes = 0
        self._dropped_bytes = 0
        self.channel_name: str | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        """Find the up channel and spawn the reader thread.

        Raises pyOCD's RTTError if no control block is found, or ValueError if
        the control block has no up channels.
        """
        with self._target_lock:
            up_channel = pyocd_ops.open_up_channel(
                self._session, control_block_address=self._control_block_address
            )
        if up_channel is None:
            raise ValueError("RTT control block has no up channels.")
        self.channel_name = up_channel.name
        self._up_channel = up_channel
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="boardex-rtt-logger", daemon=True
        )
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            chunk = b""
            with self._target_lock:
                try:
                    chunk = self._up_channel.read()
                except Exception:  # noqa: BLE001 - keep the logger alive on glitches
                    chunk = b""
            if chunk:
                self._append(chunk)
            else:
                time.sleep(self._poll_interval_s)

    def _append(self, chunk: bytes) -> None:
        with self._buffer_lock:
            self._buffer.extend(chunk)
            self._total_bytes += len(chunk)
            overflow = len(self._buffer) - self._max_buffer_bytes
            if overflow > 0:
                del self._buffer[:overflow]
                self._dropped_bytes += overflow

    def drain(self) -> tuple[bytes, int, int]:
        """Return and clear buffered bytes, plus (total_seen, dropped)."""
        with self._buffer_lock:
            data = bytes(self._buffer)
            self._buffer.clear()
            return data, self._total_bytes, self._dropped_bytes

    def buffered_bytes(self) -> int:
        with self._buffer_lock:
            return len(self._buffer)

    def stop(self, timeout_s: float = 2.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout_s)
            self._thread = None


class ManagedSession:
    """A live, persistent debug session for one target."""

    def __init__(
        self, session_id: str, device_id: str, session: Any, target: str | None
    ) -> None:
        self.session_id = session_id
        self.device_id = device_id
        self.target = target
        self._session = session
        self._lock = threading.RLock()
        self._rtt: _RttLogger | None = None

    def run(self, operation: Callable[[Any], OperationResult]) -> OperationResult:
        """Execute a pyocd_ops operation against this session under the lock."""
        with pyocd_ops.translate_errors():
            with self._lock:
                return operation(self._session)

    # -- RTT streaming -----------------------------------------------------

    def start_rtt(self, *, control_block_address: int | None = None) -> OperationResult:
        if self._rtt is not None and self._rtt.running:
            return OperationResult.passed(
                "RTT logging already running.",
                channel=self._rtt.channel_name,
            )
        from pyocd.core import exceptions as pyocd_exc

        logger = _RttLogger(
            self._session, self._lock, control_block_address=control_block_address
        )
        try:
            with pyocd_ops.translate_errors():
                logger.start()
        except pyocd_exc.RTTError as exc:
            return OperationResult.inconclusive(
                "No SEGGER RTT control block found. Is the firmware built with "
                "RTT enabled?",
                detail=str(exc),
            )
        except ValueError as exc:
            return OperationResult.inconclusive(str(exc))

        self._rtt = logger
        return OperationResult.passed(
            "RTT logging started.", channel=logger.channel_name
        )

    def read_rtt(self) -> OperationResult:
        if self._rtt is None:
            return OperationResult.inconclusive(
                "RTT logging is not running; call start_rtt first."
            )
        data, total, dropped = self._rtt.drain()
        warnings = []
        if dropped:
            warnings.append(
                f"{dropped} bytes were dropped (buffer overflow); read more often."
            )
        result = OperationResult.passed(
            f"Drained {len(data)} bytes of buffered RTT output.",
            text=data.decode("utf-8", "backslashreplace"),
            byte_count=len(data),
            total_bytes=total,
            channel=self._rtt.channel_name,
            running=self._rtt.running,
        )
        result.warnings = warnings
        return result

    def stop_rtt(self) -> OperationResult:
        if self._rtt is None:
            return OperationResult.passed("RTT logging was not running.")
        self._rtt.stop()
        remaining = self._rtt.buffered_bytes()
        self._rtt = None
        return OperationResult.passed(
            "RTT logging stopped.", buffered_bytes_discarded=remaining
        )

    def info(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "device_id": self.device_id,
            "target": self.target,
            "rtt_running": self._rtt is not None and self._rtt.running,
            "rtt_channel": self._rtt.channel_name if self._rtt else None,
            "rtt_buffered_bytes": self._rtt.buffered_bytes() if self._rtt else 0,
        }

    def close(self) -> None:
        """Stop RTT and close the underlying probe session."""
        if self._rtt is not None:
            self._rtt.stop()
            self._rtt = None
        with self._lock:
            try:
                self._session.close()
            except Exception:  # noqa: BLE001 - best effort on teardown
                pass


class SessionManager:
    """Owns all open ManagedSessions; enforces one session per device."""

    def __init__(self) -> None:
        self._sessions: dict[str, ManagedSession] = {}
        self._by_device: dict[str, str] = {}
        self._lock = threading.Lock()
        self._counter = 0

    def open(
        self, device_id: str, unique_id: str, *, target: str | None = None
    ) -> ManagedSession:
        with self._lock:
            if device_id in self._by_device:
                existing = self._by_device[device_id]
                raise DeviceBusyError(
                    f"A session ({existing}) is already open for {device_id}. "
                    "Close it before opening another."
                )
            # attach mode: don't reset/halt on connect, so the target keeps
            # running and RTT can stream immediately.
            session_obj = pyocd_ops.open_session(
                unique_id, target=target, connect_mode="attach"
            )
            with pyocd_ops.translate_errors():
                session_obj.open()

            self._counter += 1
            session_id = f"sess-{self._counter}"
            managed = ManagedSession(session_id, device_id, session_obj, target)
            self._sessions[session_id] = managed
            self._by_device[device_id] = session_id
            return managed

    def get(self, session_id: str) -> ManagedSession:
        session = self._sessions.get(session_id)
        if session is None:
            known = ", ".join(sorted(self._sessions)) or "<none>"
            raise DeviceNotFoundError(
                f"No open session '{session_id}'. Open sessions: {known}."
            )
        return session

    def find_by_device(self, device_id: str) -> ManagedSession | None:
        session_id = self._by_device.get(device_id)
        return self._sessions.get(session_id) if session_id else None

    def close(self, session_id: str) -> ManagedSession:
        with self._lock:
            managed = self._sessions.pop(session_id, None)
            if managed is None:
                known = ", ".join(sorted(self._sessions)) or "<none>"
                raise DeviceNotFoundError(
                    f"No open session '{session_id}'. Open sessions: {known}."
                )
            self._by_device.pop(managed.device_id, None)
        managed.close()
        return managed

    def list(self) -> list[dict[str, Any]]:
        return [s.info() for s in self._sessions.values()]
