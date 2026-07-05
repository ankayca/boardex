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


def _mass_erase(session: Any) -> bool:
    """Erase all of flash. Returns True if the erase was actually performed."""
    target = session.target
    try:
        # Most pyOCD targets implement a direct mass_erase(); it returns truthy
        # on success.
        return bool(target.mass_erase())
    except (AttributeError, NotImplementedError):
        # Fall back to the flash eraser's chip-erase mode.
        from pyocd.flash.eraser import FlashEraser

        FlashEraser(session, FlashEraser.Mode.CHIP).erase()
        return True


def recover(session: Any, *, mass_erase: bool = True) -> OperationResult:
    """Reclaim a wedged target. Expects a session opened *under reset*.

    Connecting under reset catches the core out of reset before firmware can
    disable SWD / sleep / spin, so we can halt it and (optionally) wipe the
    offending image out of flash. Leaves the core halted and reclaimable.
    """
    started = time.monotonic()
    target = session.target
    steps: list[str] = []

    target.reset_and_halt()
    steps.append("connected under reset and halted the core")

    erased = False
    if mass_erase:
        erased = _mass_erase(session)
        steps.append(
            "mass-erased flash" if erased else "mass-erase unsupported, skipped"
        )
        # Re-establish a clean halted state after erasing.
        target.reset_and_halt()
        steps.append("reset and halted after erase")

    result = OperationResult.passed(
        "Recovered target: " + "; ".join(steps) + ".",
        mass_erased=erased,
        steps=steps,
        core_halted=True,
    )
    result.duration_s = round(time.monotonic() - started, 3)
    return result


def _read_word(session: Any, address: int) -> int:
    return int(session.target.read_memory_block32(address, 1)[0])


def read_core_status(
    session: Any, *, elf: Any = None, halt: bool = False
) -> OperationResult:
    """Read core run state, PC (when halted) and decode any latched fault.

    Pure introspection by default: SCB fault registers are read over the debug
    memory bus (which works while the core runs), so a running-but-crashed core
    (spinning in a default fault handler) is still diagnosable without halting.
    The faulting PC and register frame live in the auto-stacked exception frame,
    which is only readable when halted -- pass ``halt=True`` to halt the core in
    this same connection and recover them (the core was crashed anyway). An
    optional ``elf`` (``ElfInfo``) maps addresses to ``func (file:line)``.
    """
    from pyocd.core.target import Target

    from . import cortex_m

    target = session.target

    def _current_halted() -> bool:
        try:
            st = target.get_state()
            return st == Target.State.HALTED
        except Exception:  # noqa: BLE001
            return target.is_halted()

    halted = _current_halted()
    halted_for_dump = False
    if halt and not halted:
        target.halt()
        halted = _current_halted()
        halted_for_dump = True

    try:
        state = target.get_state()
        state_name = state.name.lower() if hasattr(state, "name") else str(state)
    except Exception:  # noqa: BLE001 - state query must never mask the fault read
        state_name = "halted" if halted else "unknown"

    icsr = _read_word(session, cortex_m.ICSR)
    vectactive = icsr & 0x1FF
    cfsr = _read_word(session, cortex_m.CFSR)
    hfsr = _read_word(session, cortex_m.HFSR)
    mmfar = _read_word(session, cortex_m.MMFAR)
    bfar = _read_word(session, cortex_m.BFAR)

    faults = cortex_m.decode_faults(cfsr, hfsr, mmfar=mmfar, bfar=bfar)
    in_fault_handler = vectactive in cortex_m._FAULT_EXCEPTIONS
    active_exception = cortex_m.exception_name(vectactive)

    data: dict[str, Any] = {
        "state": state_name,
        "running": not halted,
        "halted": halted,
        "halted_by_this_call": halted_for_dump,
        "active_exception": active_exception,
        "in_fault_handler": in_fault_handler,
        "faulted": faults["faulted"],
        "faults": faults,
    }

    fault_location: str | None = None
    # Core registers (and thus the stacked frame) are only readable when halted.
    if halted:
        registers: dict[str, int] = {}
        for name in ("pc", "lr", "sp", "msp", "psp", "xpsr"):
            try:
                registers[name] = int(target.read_core_register(name))
            except Exception:  # noqa: BLE001 - best effort per register
                pass
        data["registers"] = registers
        if "pc" in registers:
            data["pc"] = registers["pc"]
            if elf is not None:
                data["pc_location"] = elf.describe(registers["pc"])

        lr = registers.get("lr", 0)
        if cortex_m.is_exc_return(lr):
            frame = _read_exception_frame(session, registers, lr)
            if frame is not None:
                data["stacked_frame"] = frame
                data["fault_pc"] = frame["pc"]
                if elf is not None:
                    resolved = elf.resolve_address(frame["pc"])
                    fault_location = elf.describe(frame["pc"])
                    data["fault_location"] = fault_location
                    # If the stacked PC lands in a real function the frame is
                    # trustworthy; otherwise flag it (a handler prologue may have
                    # moved the stack pointer we read the frame from).
                    data["fault_pc_confidence"] = (
                        "high" if resolved and "symbol" in resolved else "low"
                    )

    crashed = faults["faulted"] or in_fault_handler
    if crashed:
        where = f" in {active_exception} handler" if in_fault_handler else ""
        summary = f"Core crashed{where}: {faults['reason']}"
        if fault_location is not None:
            summary += f" Faulting instruction: {fault_location}."
        elif not halted:
            summary += (
                " Re-read status with halt=True to recover the faulting PC and "
                "source location."
            )
    elif halted:
        pc = data.get("pc")
        loc = data.get("pc_location")
        where = f" at {loc}" if loc else (f" at PC {pc:#010x}" if pc is not None else "")
        summary = f"Core is halted{where}. No fault latched."
    else:
        summary = (
            f"Core is running ({active_exception}); no fault latched. "
            "If firmware seems silent it is likely stuck in a loop, not crashed."
        )

    return OperationResult.passed(summary, **data)


def _read_exception_frame(
    session: Any, registers: dict[str, int], exc_return: int
) -> dict[str, int] | None:
    """Read and decode the 8-word auto-stacked exception frame, if reachable."""
    from . import cortex_m

    uses_psp = cortex_m.exc_return_uses_psp(exc_return)
    frame_sp = registers.get("psp" if uses_psp else "msp")
    if frame_sp is None:
        frame_sp = registers.get("sp")
    if not frame_sp:
        return None
    try:
        words = [int(w) for w in session.target.read_memory_block32(frame_sp, 8)]
    except Exception:  # noqa: BLE001 - unreadable stack must not break status
        return None
    frame = cortex_m.decode_exception_frame(words)
    frame["frame_sp"] = frame_sp
    frame["stack"] = "psp" if uses_psp else "msp"
    return frame


def read_memory(session: Any, address: int, length: int) -> OperationResult:
    data = bytes(session.target.read_memory_block8(address, length))
    word_aligned = (address % 4) == 0
    result = OperationResult.passed(
        f"Read {length} bytes @ {address:#010x}.",
        # ``address`` is echoed for backwards compatibility; ``requested_address``
        # makes it explicit that we report exactly what was asked for (the debug
        # access is byte-wise, so no probe-side aliasing is applied to the value).
        address=address,
        requested_address=address,
        word_aligned=word_aligned,
        length=length,
        hex=data.hex(),
    )
    if not word_aligned:
        result.warnings.append(
            f"Address {address:#010x} is not 32-bit aligned. Some peripheral "
            "registers require word (32-bit) access; a byte read here can return "
            "wrong values. Read the containing word (mask to a 4-byte boundary)."
        )
    return result


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
