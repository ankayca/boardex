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


def _silent_progress(*_args: Any, **_kwargs: Any) -> None:
    """No-op pyOCD progress callback.

    pyOCD's default ``FileProgrammer`` progress reporter writes ``[====...]`` /
    erase bars to ``sys.stdout``. When this server runs as a stdio MCP server,
    stdout IS the JSON-RPC transport, so those bars corrupt the framing and the
    client's stdout reader throws ``Invalid JSON`` on lines like
    ``[========================================]``. Passing an explicit no-op
    progress callback suppresses pyOCD's console output entirely; its own
    logging still goes to stderr, which is safe.
    """


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
    # progress=_silent_progress: keep pyOCD's flash bars off stdout, which is the
    # MCP stdio transport (a leaked bar corrupts JSON-RPC framing).
    FileProgrammer(session, progress=_silent_progress).program(firmware_path)  # .elf/.hex/.bin
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


# -- halt-mode (interactive) debugging -------------------------------------
#
# Everything below stops the core and looks around. It only makes sense inside
# one persistent session: a stopped core, breakpoints and watchpoints do not
# survive a fresh connect (Phase 1 already showed halt state is per-connection),
# so the adapter refuses to run these transiently.

# Core registers worth dumping at a stop (order is display order, not stacking).
_CORE_REGS = ("r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9",
              "r10", "r11", "r12", "sp", "lr", "pc", "xpsr", "msp", "psp")

_WATCHPOINT_ACCESS = {"read", "write", "read_write"}


def _target_state(target: Any) -> Any:
    from pyocd.core.target import Target

    try:
        return target.get_state()
    except Exception:  # noqa: BLE001
        return Target.State.HALTED if target.is_halted() else Target.State.RUNNING


def _is_halted(target: Any) -> bool:
    from pyocd.core.target import Target

    return _target_state(target) == Target.State.HALTED


def _read_registers(target: Any) -> dict[str, int]:
    """Read the core register file (best effort; skips any that error)."""
    regs: dict[str, int] = {}
    for name in _CORE_REGS:
        try:
            regs[name] = int(target.read_core_register(name)) & 0xFFFFFFFF
        except Exception:  # noqa: BLE001 - a missing reg must not abort the dump
            pass
    return regs


def _naive_backtrace(
    session: Any, registers: dict[str, int], *, elf: Any, max_frames: int
) -> list[dict[str, Any]]:
    """Heuristic call stack: current PC + LR + Thumb return addresses on the stack.

    This is deliberately simple (no DWARF CFI): frame 0 is the PC, frame 1 is LR
    when it resolves, and remaining frames are stack words that look like Thumb
    return addresses (odd, resolving into a known function). Callers must treat
    it as low-confidence.
    """
    frames: list[dict[str, Any]] = []

    def _describe(addr: int) -> str:
        return elf.describe(addr) if elf is not None else f"{addr:#010x}"

    def _in_function(addr: int) -> bool:
        # Require a real function (symbol) match, not merely a nearest line row:
        # the DWARF line lookup is unbounded, so a random stack word can spuriously
        # "resolve" to a file:line. A symbol hit means the address is inside a
        # known function's [addr, addr+size) range.
        if elf is None:
            return False
        info = elf.resolve_address(addr & ~1)
        return info is not None and "symbol" in info

    seen: set[int] = set()
    pc = registers.get("pc")
    if pc is not None:
        frames.append({"pc": pc, "location": _describe(pc)})
        seen.add(pc & ~1)

    lr = registers.get("lr", 0)
    if lr and not (lr & 0xFFFFFFF0) == 0xFFFFFFF0 and (lr & ~1) not in seen:
        frames.append({"pc": lr, "location": _describe(lr)})
        seen.add(lr & ~1)

    sp = registers.get("sp")
    if sp and elf is not None and len(frames) < max_frames:
        try:
            words = [int(w) & 0xFFFFFFFF for w in session.target.read_memory_block32(sp, 256)]
        except Exception:  # noqa: BLE001 - unreadable stack ends the walk
            words = []
        for word in words:
            if len(frames) >= max_frames:
                break
            if word & 1 and (word & ~1) not in seen and _in_function(word):
                frames.append({"pc": word, "location": _describe(word)})
                seen.add(word & ~1)
    return frames


def _context_dump(
    session: Any,
    *,
    elf: Any,
    reason: str,
    timed_out: bool,
    max_frames: int = 16,
) -> dict[str, Any]:
    """Full source-mapped stop context: pc, location, registers, backtrace."""
    target = session.target
    registers = _read_registers(target)
    data: dict[str, Any] = {
        "stopped": True,
        "reason": reason,
        "timed_out": timed_out,
        "registers": registers,
    }
    pc = registers.get("pc")
    if pc is not None:
        data["pc"] = pc
        data["location"] = elf.describe(pc) if elf is not None else f"{pc:#010x}"
    data["backtrace"] = _naive_backtrace(
        session, registers, elf=elf, max_frames=max_frames
    )
    data["backtrace_confidence"] = "low"
    return data


def read_registers(session: Any, *, elf: Any = None) -> OperationResult:
    """Read the core register file at a stop (requires a halted core)."""
    target = session.target
    if not _is_halted(target):
        return OperationResult.errored(
            "Core is running; registers are only readable when halted. "
            "Call run_until/step/halt_target first."
        )
    registers = _read_registers(target)
    data: dict[str, Any] = {"registers": registers}
    pc = registers.get("pc")
    if pc is not None:
        data["pc"] = pc
        data["pc_location"] = elf.describe(pc) if elf is not None else f"{pc:#010x}"
    where = f" at {data['pc_location']}" if "pc_location" in data else ""
    return OperationResult.passed(f"Read {len(registers)} core registers{where}.", **data)


def write_register(session: Any, name: str, value: int) -> OperationResult:
    """Write one core register by name (requires a halted core)."""
    target = session.target
    if not _is_halted(target):
        return OperationResult.errored(
            "Core is running; registers can only be written when halted."
        )
    target.write_core_register(name, value & 0xFFFFFFFF)
    readback = int(target.read_core_register(name)) & 0xFFFFFFFF
    return OperationResult.passed(
        f"Wrote {name} = {value:#010x} (read back {readback:#010x}).",
        register=name,
        value=value & 0xFFFFFFFF,
        readback=readback,
    )


def step_core(
    session: Any, *, count: int = 1, over: bool = True, elf: Any = None
) -> OperationResult:
    """Single-step ``count`` instructions and return the new stop context.

    ``over`` maps to pyOCD's instruction step (it does not skip whole callees at
    source granularity); it is accepted so the coarse tool surface is stable, and
    reported back so the agent knows what actually happened.
    """
    target = session.target
    halted_by_call = False
    if not _is_halted(target):
        target.halt()
        halted_by_call = True
    steps = max(int(count), 1)
    for _ in range(steps):
        # If parked on a breakpoint, stepping off it counts as this step.
        if not _clear_pc_breakpoint_and_step(target):
            target.step(disable_interrupts=over)
    data = _context_dump(session, elf=elf, reason="step", timed_out=False)
    data["steps"] = steps
    data["over"] = over
    data["halted_by_this_call"] = halted_by_call
    loc = data.get("location", "")
    return OperationResult.passed(
        f"Stepped {steps} instruction(s); stopped at {loc}.", **data
    )


def _clear_pc_breakpoint_and_step(target: Any) -> bool:
    """If a breakpoint sits at the current PC, step one instruction past it.

    Resuming (or stepping) with the core parked on an active breakpoint would
    re-trigger it immediately and never make progress — the classic debugger
    "breakpoint at current PC" problem. We temporarily lift the breakpoint,
    single-step over the instruction, then restore it. Returns True if it did.
    """
    try:
        pc = int(target.read_core_register("pc")) & ~1
    except Exception:  # noqa: BLE001
        return False
    if target.find_breakpoint(pc) is None:
        return False
    target.remove_breakpoint(pc)
    try:
        target.step(disable_interrupts=True)
    finally:
        target.set_breakpoint(pc)
    return True


def set_breakpoint(session: Any, address: int) -> OperationResult:
    """Set a breakpoint at ``address`` (idempotent). Reports a clean error when
    no hardware breakpoint slot is free."""
    address &= ~1  # breakpoints live on even (halfword) addresses; drop Thumb bit
    target = session.target
    if target.find_breakpoint(address) is not None:
        return OperationResult.passed(
            f"Breakpoint already set at {address:#010x}.",
            address=address,
            already_set=True,
        )
    ok = bool(target.set_breakpoint(address))
    if not ok:
        return OperationResult.errored(
            f"Could not set breakpoint at {address:#010x}: no hardware breakpoint "
            "slot free (Cortex-M FPB has a small fixed number). Clear one first "
            "(see list_debug_resources).",
            address=address,
        )
    return OperationResult.passed(
        f"Breakpoint set at {address:#010x}.", address=address, already_set=False
    )


def clear_breakpoint(session: Any, address: int) -> OperationResult:
    address &= ~1
    target = session.target
    if target.find_breakpoint(address) is None:
        return OperationResult.passed(
            f"No breakpoint at {address:#010x} to clear.", address=address, was_set=False
        )
    target.remove_breakpoint(address)
    return OperationResult.passed(
        f"Cleared breakpoint at {address:#010x}.", address=address, was_set=True
    )


def _watchpoint_type(access: str) -> Any:
    from pyocd.core.target import Target

    return {
        "read": Target.WatchpointType.READ,
        "write": Target.WatchpointType.WRITE,
        "read_write": Target.WatchpointType.READ_WRITE,
    }[access]


def set_watchpoint(
    session: Any, address: int, *, size: int = 4, access: str = "write"
) -> OperationResult:
    """Set a data watchpoint. The marquee capability: catch the instruction that
    reads/writes ``address`` (then ``run_until`` reports it as ``func (file:line)``)."""
    if access not in _WATCHPOINT_ACCESS:
        return OperationResult.errored(
            f"Unknown watchpoint access {access!r}; use one of {sorted(_WATCHPOINT_ACCESS)}."
        )
    ok = bool(session.target.set_watchpoint(address, size, _watchpoint_type(access)))
    if not ok:
        return OperationResult.errored(
            f"Could not set {access} watchpoint at {address:#010x}: no DWT "
            "watchpoint slot free. Clear one first (see list_debug_resources).",
            address=address,
        )
    return OperationResult.passed(
        f"{access.capitalize()} watchpoint set at {address:#010x} (size {size}).",
        address=address,
        size=size,
        access=access,
    )


def clear_watchpoint(
    session: Any, address: int, *, size: int = 4, access: str = "write"
) -> OperationResult:
    if access not in _WATCHPOINT_ACCESS:
        return OperationResult.errored(
            f"Unknown watchpoint access {access!r}; use one of {sorted(_WATCHPOINT_ACCESS)}."
        )
    session.target.remove_watchpoint(address, size, _watchpoint_type(access))
    return OperationResult.passed(
        f"Cleared {access} watchpoint at {address:#010x}.",
        address=address,
        size=size,
        access=access,
    )


def run_until(
    session: Any,
    *,
    address: int | None = None,
    timeout_s: float = 5.0,
    elf: Any = None,
    max_frames: int = 16,
) -> OperationResult:
    """Set-if-needed + resume + wait: the headline halt-mode tool.

    Sets a breakpoint at ``address`` (if given and not already set), resumes, and
    waits up to ``timeout_s`` for the core to stop (breakpoint or watchpoint hit).
    On timeout it halts the core so the session is left in a known state. Returns
    a single source-mapped context dump either way; the agent branches on
    ``data.timed_out`` / verdict.
    """
    target = session.target
    set_here = False
    if address is not None:
        address &= ~1  # even (halfword) breakpoint address; drop Thumb bit
        if target.find_breakpoint(address) is None:
            if not bool(target.set_breakpoint(address)):
                return OperationResult.errored(
                    f"Could not set breakpoint at {address:#010x}: no hardware "
                    "breakpoint slot free (see list_debug_resources).",
                    address=address,
                )
            set_here = True

    if _is_halted(target):
        # Step off any breakpoint parked at the current PC first, else the
        # resume below would re-trigger it immediately without progressing.
        _clear_pc_breakpoint_and_step(target)
        if _is_halted(target):
            target.resume()

    started = time.monotonic()
    deadline = started + max(timeout_s, 0.0)
    timed_out = True
    while time.monotonic() < deadline:
        if _is_halted(target):
            timed_out = False
            break
        time.sleep(0.01)

    if timed_out:
        target.halt()

    reason = "timeout" if timed_out else ("breakpoint" if address is not None else "halt")
    data = _context_dump(
        session, elf=elf, reason=reason, timed_out=timed_out, max_frames=max_frames
    )
    data["breakpoint_set_by_this_call"] = set_here
    if address is not None:
        data["target_address"] = address

    if timed_out:
        result = OperationResult.failed(
            f"Core did not stop within {timeout_s:.1f}s (halted it). "
            f"Now at {data.get('location', '?')}.",
            **data,
        )
    else:
        result = OperationResult.passed(f"Stopped at {data.get('location', '?')}.", **data)
    result.duration_s = round(time.monotonic() - started, 3)
    return result


def debug_resources(session: Any) -> OperationResult:
    """Report hardware breakpoint/watchpoint capacity and what is currently set.

    Lets the agent see why a ``set_breakpoint`` failed ("no slot free") and plan
    around Cortex-M's small fixed budget instead of guessing.
    """
    target = session.target
    core = getattr(target, "selected_core", None) or target
    data: dict[str, Any] = {}

    def _try(fn: Callable[[], Any]) -> Any:
        try:
            return fn()
        except Exception:  # noqa: BLE001 - introspection is best-effort
            return None

    bp_free = _try(lambda: int(core.available_breakpoint_count))
    bp_set = _try(lambda: [int(a) for a in core.bp_manager.get_breakpoints()])
    wp_total = _try(lambda: int(core.dwt.watchpoint_count))
    wp_used = _try(lambda: len(core.dwt.get_watchpoints()))

    if bp_free is not None:
        data["hw_breakpoints_free"] = bp_free
    if bp_set is not None:
        data["breakpoints_set"] = [f"{a:#010x}" for a in bp_set]
        data["breakpoints_set_count"] = len(bp_set)
    if wp_total is not None:
        data["watchpoints_total"] = wp_total
    if wp_used is not None:
        data["watchpoints_used"] = wp_used
        if wp_total is not None:
            data["watchpoints_free"] = max(wp_total - wp_used, 0)

    return OperationResult.passed(
        "Debug resource usage: "
        f"{data.get('hw_breakpoints_free', '?')} HW breakpoint slot(s) free, "
        f"{data.get('watchpoints_free', '?')} watchpoint slot(s) free.",
        **data,
    )


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
