"""Persistent debug sessions with a background RTT logger.

A ``ManagedSession`` keeps one backend-native session open so the agent can
flash, then stream firmware logs, then flash again without re-claiming the
probe each time.

This layer is vendor-neutral: it only speaks the ``NativeSession`` /
``RttChannel`` protocols from ``boardex_core``. Which vendor SDK actually
backs the session is the adapter's business (``SupportsSessions``), so any
probe backend that implements those protocols gets persistent sessions and RTT
streaming for free.

Concurrency model: a single probe/DAP is *not* thread-safe, so the backend's
``NativeSession`` serialises every access to the device internally (including
``RttChannel.read``). The background RTT reader thread drops what it reads into
a separate, independently-locked ring buffer that ``read_rtt`` drains.
"""

from __future__ import annotations

import re
import threading
import time
from typing import Any, Callable

from boardex_core import (
    DeviceBusyError,
    DeviceNotFoundError,
    NativeSession,
    OperationFailedError,
    OperationResult,
    RttChannel,
    RttUnavailableError,
    SupportsRttLocation,
    SupportsSessions,
)


def _find_match(text: str, pattern: str, *, regex: bool) -> int | None:
    """Return the end index of ``pattern`` in ``text``, or None. Pure/testable."""
    if regex:
        found = re.search(pattern, text)
        return found.end() if found else None
    index = text.find(pattern)
    return index + len(pattern) if index >= 0 else None


class _RttLogger:
    """Background thread that continuously drains one RTT up channel."""

    def __init__(
        self,
        channel: RttChannel | None,
        *,
        poll_interval_s: float = 0.05,
        max_buffer_bytes: int = 1_000_000,
    ) -> None:
        self._channel = channel
        self._poll_interval_s = poll_interval_s
        self._max_buffer_bytes = max_buffer_bytes

        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

        self._buffer_lock = threading.Lock()
        self._buffer = bytearray()
        self._total_bytes = 0
        self._dropped_bytes = 0
        self.channel_name: str | None = (
            getattr(channel, "name", None) if channel is not None else None
        )

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        """Spawn the reader thread for the already-open channel."""
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="boardex-rtt-logger", daemon=True
        )
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            chunk = b""
            try:
                chunk = self._channel.read() if self._channel is not None else b""
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

    def discard(self) -> int:
        """Drop everything currently buffered without returning it.

        Used to throw away stale output left over from a previous firmware
        image after a flash/reset, so a later ``wait_for_rtt`` can't match it.
        """
        with self._buffer_lock:
            dropped = len(self._buffer)
            self._buffer.clear()
            return dropped

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
        self,
        session_id: str,
        device_id: str,
        native: NativeSession | None,
        target: str | None,
    ) -> None:
        self.session_id = session_id
        self.device_id = device_id
        self.target = target
        self._native = native
        self._rtt: _RttLogger | None = None
        self._run_epoch = 0

    @property
    def run_epoch(self) -> int:
        """Monotonic counter bumped on every fresh flash/verification cycle."""
        return self._run_epoch

    def run(self, operation: Callable[[Any], OperationResult]) -> OperationResult:
        """Execute an operation against this session's native backend session."""
        return self._native.run(operation)

    # -- RTT streaming -----------------------------------------------------

    def start_rtt(self, *, control_block_address: int | None = None) -> OperationResult:
        if self._rtt is not None and self._rtt.running:
            return OperationResult.passed(
                "RTT logging already running.",
                channel=self._rtt.channel_name,
            )
        try:
            channel = self._native.open_rtt(
                control_block_address=control_block_address
            )
        except RttUnavailableError as exc:
            return OperationResult.inconclusive(str(exc))

        logger = _RttLogger(channel)
        logger.start()
        self._rtt = logger
        return OperationResult.passed(
            "RTT logging started.", channel=logger.channel_name
        )

    def discard_rtt_backlog(self) -> int:
        """Throw away buffered RTT output; no-op (returns 0) if not running.

        Called right after a flash/reset so the next ``read_rtt``/``wait_for_rtt``
        only sees output produced by the freshly-loaded image, never a stale
        banner or result line from the previous run.
        """
        if self._rtt is None:
            return 0
        return self._rtt.discard()

    def mark_fresh_run(self) -> int:
        """Discard RTT backlog and bump ``run_epoch`` for a new verification cycle."""
        dropped = self.discard_rtt_backlog()
        self._run_epoch += 1
        return dropped

    def prepare_for_run(self) -> OperationResult:
        """Discard buffered RTT and bump the run epoch for session hygiene.

        Call before a fresh flash/wait cycle when you want to guarantee no stale
        RTT text is matched. ``flash_firmware``/``reset_target`` already drain the
        buffer; this covers manual re-runs without a reflash.
        """
        discarded = self.mark_fresh_run()
        info = self.info()
        info.pop("run_epoch", None)
        return OperationResult.passed(
            f"Session prepared (discarded {discarded} RTT byte(s)).",
            rtt_backlog_discarded=discarded,
            run_epoch=self._run_epoch,
            **info,
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

    def wait_for_rtt(
        self,
        pattern: str,
        *,
        timeout_s: float = 5.0,
        regex: bool = False,
        since_last_flash: bool = True,
        poll_interval_s: float = 0.05,
    ) -> OperationResult:
        """Block until ``pattern`` appears in the RTT stream or ``timeout_s``.

        The thin ergonomic helper the agent uses to turn "flash and run" into a
        deterministic checkpoint: wait for e.g. "SELF-TEST PASS". The agent still
        judges the outcome via ``data.matched`` (verdict is only a sensible
        default: PASS when found, FAIL on timeout). Consumes the buffered stream
        up to the match and returns it in ``data.text``.

        ``since_last_flash`` (default True) discards anything already buffered
        when the wait begins, so the pattern can only match output that arrives
        *after* this call. This is what prevents a false positive from a stale
        banner/result line left in the buffer by a previous firmware image.
        Pass False to also consider output buffered before the call.
        """
        if self._rtt is None:
            return OperationResult.inconclusive(
                "RTT logging is not running; call start_rtt before wait_for_rtt."
            )
        if since_last_flash:
            self._rtt.discard()
        started = time.monotonic()
        deadline = started + max(timeout_s, 0.0)
        collected = bytearray()
        while True:
            data, _total, _dropped = self._rtt.drain()
            collected.extend(data)
            text = collected.decode("utf-8", "backslashreplace")
            end = _find_match(text, pattern, regex=regex)
            if end is not None:
                result = OperationResult.passed(
                    f"Matched {'regex' if regex else 'text'} {pattern!r} in RTT output.",
                    matched=True,
                    timed_out=False,
                    pattern=pattern,
                    text=text,
                    channel=self._rtt.channel_name,
                )
                result.duration_s = round(time.monotonic() - started, 3)
                return result
            if time.monotonic() >= deadline:
                result = OperationResult.failed(
                    f"Pattern {pattern!r} not seen in RTT within {timeout_s:.1f}s.",
                    matched=False,
                    timed_out=True,
                    pattern=pattern,
                    text=text,
                    channel=self._rtt.channel_name,
                )
                result.duration_s = round(time.monotonic() - started, 3)
                return result
            time.sleep(poll_interval_s)

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
            "run_epoch": self._run_epoch,
        }

    def close(self) -> None:
        """Stop RTT and close the underlying native session."""
        if self._rtt is not None:
            self._rtt.stop()
            self._rtt = None
        if self._native is not None:
            try:
                self._native.close()
            except Exception:  # noqa: BLE001 - best effort on teardown
                pass


def open_session_for(
    adapter: Any,
    sessions: "SessionManager",
    device_id: str,
    *,
    target: str | None = None,
) -> ManagedSession:
    """Open a persistent session for ``device_id`` via its owning adapter.

    Single implementation of the "check capability, then open" step shared by
    the ``open_session`` tool and the composite workflows. Raises a typed
    ``OperationFailedError`` when the backend cannot do sessions, so the facade
    guard converts it into an actionable error result.
    """
    if not isinstance(adapter, SupportsSessions):
        raise OperationFailedError(
            f"Backend {getattr(adapter, 'backend_name', '?')!r} does not support "
            "persistent debug sessions."
        )
    return sessions.open(adapter, device_id, target=target)


def start_session_rtt(
    session: ManagedSession,
    adapter: Any,
    *,
    control_block_address: int | None = None,
    elf_path: str | None = None,
) -> OperationResult:
    """Start RTT on ``session``, resolving the control block via the adapter.

    Single implementation of the "resolve ``_SEGGER_RTT`` from the adapter's
    ``SupportsRttLocation`` capability, then start" step shared by the
    ``start_rtt`` tool and the composite workflows. Idempotent: an already
    running stream reports success without restarting.
    """
    address = control_block_address
    if address is None and isinstance(adapter, SupportsRttLocation):
        address = adapter.rtt_control_block(session.device_id, elf_path)
    return session.start_rtt(control_block_address=address)


class SessionManager:
    """Owns all open ManagedSessions; enforces one session per device."""

    def __init__(self) -> None:
        self._sessions: dict[str, ManagedSession] = {}
        self._by_device: dict[str, str] = {}
        self._lock = threading.Lock()
        self._counter = 0

    def open(
        self,
        adapter: SupportsSessions,
        device_id: str,
        *,
        target: str | None = None,
    ) -> ManagedSession:
        """Open a persistent session for ``device_id`` via its owning adapter.

        The adapter's ``open_native_session`` attaches without perturbing the
        running target, so firmware keeps executing and RTT can stream
        immediately.
        """
        with self._lock:
            if device_id in self._by_device:
                existing = self._by_device[device_id]
                raise DeviceBusyError(
                    f"A session ({existing}) is already open for {device_id}. "
                    "Close it before opening another."
                )
            native = adapter.open_native_session(device_id, target=target)

            self._counter += 1
            session_id = f"sess-{self._counter}"
            managed = ManagedSession(session_id, device_id, native, target)
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
