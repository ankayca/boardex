"""Halt-mode (interactive) debugging tools: stop the core and look around.

The intrusive counterpart to the flash -> run -> observe loop. Where the
stateless tools answer "is it working / did it crash", these answer the harder
~20%: bugs before logging is up, memory corruption ("who wrote this address?"),
and Heisenbugs where adding a log line hides the fault.

Every tool is coarse and verdict-returning (never a raw gdb micro-op) and takes
a ``session_id`` because halt-mode state (a stopped core, breakpoints,
watchpoints) only lives inside one persistent debug session — open one with
``open_session`` first. ``run_until`` is the headline tool: set-if-needed +
resume + wait, returning a full source-mapped stop context.
"""

from __future__ import annotations

from typing import Any

from boardex_core import (
    BackendRegistry,
    OperationResult,
    SupportsHaltModeDebug,
    TargetController,
)
from mcp.server.fastmcp import FastMCP

from ..session import SessionManager
from . import guarded as _guard


def register(
    mcp: FastMCP,
    registry: BackendRegistry[TargetController],
    sessions: SessionManager,
) -> None:
    """Define the halt-mode debug tools onto ``mcp``."""

    def _with_debug(session_id: str, call: Any) -> OperationResult:
        session = sessions.get(session_id)
        adapter = registry.resolve(session.device_id)
        if not isinstance(adapter, SupportsHaltModeDebug):
            return OperationResult.errored(
                f"Backend {adapter.backend_name!r} does not support halt-mode "
                "debugging (breakpoints/run_until/step/registers)."
            )
        return call(adapter, session.device_id)

    @mcp.tool()
    def set_breakpoint(
        session_id: str, location: str, elf_path: str | None = None
    ) -> dict[str, Any]:
        """Set a breakpoint at ``location`` (a symbol, ``file:line``, or 0x address).

        Idempotent. Cortex-M has only a few hardware breakpoint slots; if none is
        free the result is a clean ``error`` (see ``list_debug_resources``), not a
        silent failure. Symbols/lines resolve from the last flashed .elf (or
        ``elf_path``).
        """
        return _guard(
            lambda: _with_debug(
                session_id,
                lambda a, dev: a.set_breakpoint(dev, location, elf_path=elf_path),
            )
        ).to_dict()

    @mcp.tool()
    def clear_breakpoint(
        session_id: str, location: str, elf_path: str | None = None
    ) -> dict[str, Any]:
        """Clear a breakpoint previously set at ``location`` and free its slot."""
        return _guard(
            lambda: _with_debug(
                session_id,
                lambda a, dev: a.clear_breakpoint(dev, location, elf_path=elf_path),
            )
        ).to_dict()

    @mcp.tool()
    def set_watchpoint(
        session_id: str,
        address: int,
        size: int = 4,
        access: str = "write",
    ) -> dict[str, Any]:
        """Set a data watchpoint on ``address`` (``access``: write/read/read_write).

        The marquee capability with no ``printf`` equivalent: pair with
        ``run_until`` to catch the instruction that reads/writes a variable and
        report it as ``func (file:line)``. Uses a DWT comparator (few slots).
        """
        return _guard(
            lambda: _with_debug(
                session_id,
                lambda a, dev: a.set_watchpoint(
                    dev, address, size=size, access=access
                ),
            )
        ).to_dict()

    @mcp.tool()
    def clear_watchpoint(
        session_id: str,
        address: int,
        size: int = 4,
        access: str = "write",
    ) -> dict[str, Any]:
        """Clear a data watchpoint and free its DWT comparator."""
        return _guard(
            lambda: _with_debug(
                session_id,
                lambda a, dev: a.clear_watchpoint(
                    dev, address, size=size, access=access
                ),
            )
        ).to_dict()

    @mcp.tool()
    def run_until(
        session_id: str,
        location: str | None = None,
        timeout_s: float = 5.0,
        elf_path: str | None = None,
    ) -> dict[str, Any]:
        """Resume the core and stop at ``location`` (or the next breakpoint/watchpoint).

        Sets a breakpoint at ``location`` if one isn't already there, resumes, and
        waits up to ``timeout_s`` for the core to stop. On timeout it halts the
        core so the session stays in a known state. Either way returns one dump in
        ``data``: ``stopped``, ``reason``, ``timed_out``, ``pc``, ``location``,
        ``registers`` and a (low-confidence) ``backtrace``. Branch on
        ``data.timed_out`` / verdict (``pass`` = stopped, ``fail`` = timed out).
        Pass no ``location`` to just resume until an already-set breakpoint or
        watchpoint fires.
        """
        return _guard(
            lambda: _with_debug(
                session_id,
                lambda a, dev: a.run_until(
                    dev, location, timeout_s=timeout_s, elf_path=elf_path
                ),
            )
        ).to_dict()

    @mcp.tool()
    def step(
        session_id: str,
        count: int = 1,
        over: bool = True,
        elf_path: str | None = None,
    ) -> dict[str, Any]:
        """Single-step ``count`` instructions and return the new stop context.

        Halts the core first if it is running. ``over`` maps to pyOCD's
        instruction step (it does not skip whole callees at source granularity)
        and is echoed back in ``data.over``. Returns ``pc``, ``location``,
        ``registers`` and a backtrace at the new stop.
        """
        return _guard(
            lambda: _with_debug(
                session_id,
                lambda a, dev: a.step(dev, count=count, over=over, elf_path=elf_path),
            )
        ).to_dict()

    @mcp.tool()
    def read_registers(
        session_id: str, elf_path: str | None = None
    ) -> dict[str, Any]:
        """Read the core register file at a stop (requires a halted core).

        Returns ``data.registers`` (r0-r12, sp, lr, pc, xpsr, msp, psp) and maps
        the PC to ``data.pc_location``. Errors if the core is running.
        """
        return _guard(
            lambda: _with_debug(
                session_id, lambda a, dev: a.read_registers(dev, elf_path=elf_path)
            )
        ).to_dict()

    @mcp.tool()
    def write_register(
        session_id: str, name: str, value: int
    ) -> dict[str, Any]:
        """Write one core register by name (e.g. ``r0``, ``pc``); requires a halted core.

        Handy for forcing a code path (patch a return value, redirect the PC)
        without recompiling. Reads the value back into ``data.readback``.
        """
        return _guard(
            lambda: _with_debug(
                session_id, lambda a, dev: a.write_register(dev, name, value)
            )
        ).to_dict()

    @mcp.tool()
    def backtrace(
        session_id: str, max_frames: int = 16, elf_path: str | None = None
    ) -> dict[str, Any]:
        """Return the call stack at a stop as ``func (file:line)`` frames.

        Requires a halted core. This is a low-confidence heuristic unwind (current
        PC + LR + Thumb return addresses found on the stack, no DWARF CFI) —
        ``data.confidence`` is ``"low"``; treat deeper frames as hints to verify.
        """
        return _guard(
            lambda: _with_debug(
                session_id,
                lambda a, dev: a.backtrace(dev, max_frames=max_frames, elf_path=elf_path),
            )
        ).to_dict()

    @mcp.tool()
    def list_debug_resources(session_id: str) -> dict[str, Any]:
        """Report hardware breakpoint/watchpoint capacity and what is set.

        Cortex-M has a small fixed number of FPB breakpoints and DWT watchpoints;
        this shows how many are free (``data.hw_breakpoints_free``,
        ``data.watchpoints_free``) and what this session currently holds, so a
        "no slot free" error from ``set_breakpoint``/``set_watchpoint`` is
        actionable.
        """
        return _guard(
            lambda: _with_debug(
                session_id, lambda a, dev: a.list_debug_resources(dev)
            )
        ).to_dict()
