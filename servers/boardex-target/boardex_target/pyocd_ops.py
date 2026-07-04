"""Low-level pyOCD operations, shared by transient and persistent sessions.

Every function here works on an already-opened pyOCD ``Session`` and returns an
``OperationResult``. Keeping the operations here (instead of in the adapter) lets
both one-shot calls (open -> do -> close) and long-lived ManagedSessions reuse
the exact same logic, so behaviour can't drift between the two paths.
"""

from __future__ import annotations

import contextlib
import time
from typing import Any, Callable, Iterator

from boardex_core import (
    DeviceBusyError,
    DeviceNotFoundError,
    OperationFailedError,
    OperationResult,
)

try:  # pyOCD is optional at import time; pyocd_available() reports the truth.
    from pyocd.core.helpers import ConnectHelper
    from pyocd.flash.file_programmer import FileProgrammer

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001
    ConnectHelper = None  # type: ignore[assignment]
    FileProgrammer = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


def pyocd_available() -> bool:
    return _IMPORT_ERROR is None


def import_error() -> Exception | None:
    return _IMPORT_ERROR


# -- session creation & error translation ---------------------------------


def open_session(
    unique_id: str,
    *,
    target: str | None = None,
    connect_mode: str | None = None,
    resume_on_disconnect: bool = True,
) -> Any:
    """Create (but do not open) a pyOCD session for a specific probe."""
    if not pyocd_available():
        raise OperationFailedError(f"pyOCD is not importable: {_IMPORT_ERROR}")

    options: dict[str, Any] = {"resume_on_disconnect": resume_on_disconnect}
    if connect_mode is not None:
        options["connect_mode"] = connect_mode

    try:
        session = ConnectHelper.session_with_chosen_probe(
            unique_id=unique_id,
            target_override=target,
            options=options,
            blocking=False,
        )
    except Exception as exc:  # noqa: BLE001
        raise OperationFailedError(f"Could not open probe session: {exc}") from exc

    if session is None:
        raise DeviceNotFoundError(
            f"No debug probe matched unique id '{unique_id}'. Is it plugged in?"
        )
    return session


@contextlib.contextmanager
def translate_errors() -> Iterator[None]:
    """Map raw pyOCD exceptions onto Boardex's typed error hierarchy."""
    try:
        yield
    except (DeviceNotFoundError, DeviceBusyError, OperationFailedError):
        raise
    except Exception as exc:  # noqa: BLE001
        message = str(exc).lower()
        if "busy" in message or "in use" in message or "locked" in message:
            raise DeviceBusyError(str(exc)) from exc
        raise OperationFailedError(str(exc)) from exc


@contextlib.contextmanager
def transient_session(
    unique_id: str,
    *,
    target: str | None = None,
    connect_mode: str | None = None,
    resume_on_disconnect: bool = True,
) -> Iterator[Any]:
    """Open a session for the duration of a single operation, then close it."""
    session = open_session(
        unique_id,
        target=target,
        connect_mode=connect_mode,
        resume_on_disconnect=resume_on_disconnect,
    )
    with translate_errors():
        with session:
            yield session


# -- operations (each takes an opened session) -----------------------------


def flash(
    session: Any,
    firmware_path: str,
    *,
    verify: bool = True,
    reset_after: bool = True,
) -> OperationResult:
    started = time.monotonic()
    FileProgrammer(session).program(firmware_path)  # auto-detects .elf/.hex/.bin
    if reset_after:
        session.target.reset()
    result = OperationResult.passed(
        f"Flashed '{firmware_path}'.",
        firmware_path=firmware_path,
        verified=verify,
        reset_after=reset_after,
    )
    result.duration_s = round(time.monotonic() - started, 3)
    return result


def reset(session: Any, *, halt: bool = False) -> OperationResult:
    if halt:
        session.target.reset_and_halt()
    else:
        session.target.reset()
    state = "reset and halted" if halt else "reset"
    return OperationResult.passed(f"Target {state}.", halted=halt)


def halt(session: Any) -> OperationResult:
    session.target.halt()
    return OperationResult.passed("Target halted.")


def resume(session: Any) -> OperationResult:
    session.target.resume()
    return OperationResult.passed("Target resumed.")


def read_memory(session: Any, address: int, length: int) -> OperationResult:
    data = bytes(session.target.read_memory_block8(address, length))
    return OperationResult.passed(
        f"Read {length} bytes @ {address:#010x}.",
        address=address,
        length=length,
        hex=data.hex(),
    )


def write_memory(session: Any, address: int, data: bytes) -> OperationResult:
    session.target.write_memory_block8(address, list(data))
    return OperationResult.passed(
        f"Wrote {len(data)} bytes @ {address:#010x}.",
        address=address,
        length=len(data),
    )


def open_up_channel(session: Any, *, control_block_address: int | None = None) -> Any:
    """Locate the SEGGER RTT control block and return its first up channel.

    Returns None if the control block exists but has no up channels. Raises
    ``pyocd...RTTError`` if no control block is found.
    """
    from pyocd.debug.rtt import RTTControlBlock

    control_block = RTTControlBlock.from_target(
        session.target, address=control_block_address
    )
    control_block.start()
    if not control_block.up_channels:
        return None
    return control_block.up_channels[0]


def read_rtt_once(
    session: Any,
    *,
    timeout_s: float = 2.0,
    control_block_address: int | None = None,
) -> OperationResult:
    """One-shot RTT drain: poll the up channel for up to ``timeout_s`` seconds."""
    from pyocd.core import exceptions as pyocd_exc

    try:
        up_channel = open_up_channel(
            session, control_block_address=control_block_address
        )
    except pyocd_exc.RTTError as exc:
        return OperationResult.inconclusive(
            "No SEGGER RTT control block found on the target. Is the firmware "
            "built with RTT enabled?",
            detail=str(exc),
        )
    if up_channel is None:
        return OperationResult.inconclusive(
            "RTT control block found but it exposes no up channels."
        )

    collected = bytearray()
    deadline = time.monotonic() + max(timeout_s, 0.0)
    while time.monotonic() < deadline:
        chunk = up_channel.read()
        if chunk:
            collected.extend(chunk)
        else:
            time.sleep(0.02)

    return OperationResult.passed(
        f"Read {len(collected)} bytes of RTT output.",
        text=collected.decode("utf-8", "backslashreplace"),
        byte_count=len(collected),
        channel=up_channel.name,
    )
