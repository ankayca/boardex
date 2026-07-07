"""Persistent debug session tools: open/close sessions and RTT streaming."""

from __future__ import annotations

from typing import Any

from boardex_core import BackendRegistry, OperationResult, TargetController
from mcp.server.fastmcp import FastMCP

from ..session import SessionManager, open_session_for, start_session_rtt
from . import guarded as _guard


def register(
    mcp: FastMCP,
    registry: BackendRegistry[TargetController],
    sessions: SessionManager,
) -> None:
    """Define the session/RTT tools onto ``mcp``."""

    @mcp.tool()
    def open_session(device_id: str, target: str | None = None) -> dict[str, Any]:
        """Open a persistent debug session for a target and keep the probe claimed.

        Required before RTT streaming. While a session is open, the plain tools
        (flash_firmware, reset_target, read_memory, ...) automatically route through
        it. Returns ``data.session_id`` for use with the RTT tools and close_session.
        """

        def _open() -> OperationResult:
            adapter = registry.resolve(device_id)
            managed = open_session_for(adapter, sessions, device_id, target=target)
            return OperationResult.passed(
                f"Opened session {managed.session_id} for {device_id}.",
                **managed.info(),
            )

        return _guard(_open).to_dict()

    @mcp.tool()
    def close_session(session_id: str) -> dict[str, Any]:
        """Close a persistent debug session and release the probe."""
        return _guard(
            lambda: OperationResult.passed(
                f"Closed session {sessions.close(session_id).session_id}."
            )
        ).to_dict()

    @mcp.tool()
    def list_sessions() -> dict[str, Any]:
        """List all currently open debug sessions."""
        open_sessions = sessions.list()
        return OperationResult.passed(
            f"{len(open_sessions)} open session(s).", sessions=open_sessions
        ).to_dict()

    @mcp.tool()
    def start_rtt(
        session_id: str,
        control_block_address: int | None = None,
        elf_path: str | None = None,
    ) -> dict[str, Any]:
        """Start background RTT log capture on an open session.

        A reader thread continuously drains the RTT up channel into a buffer; use
        ``read_rtt`` to fetch accumulated output. The control block is located from
        the ``_SEGGER_RTT`` symbol in ``elf_path`` (or the last image flashed to the
        session's device); pass ``control_block_address`` to override, or neither to
        fall back to a RAM search.
        """

        def _start() -> OperationResult:
            session = sessions.get(session_id)
            adapter = registry.resolve(session.device_id)
            return start_session_rtt(
                session,
                adapter,
                control_block_address=control_block_address,
                elf_path=elf_path,
            )

        return _guard(_start).to_dict()

    @mcp.tool()
    def read_rtt(session_id: str) -> dict[str, Any]:
        """Drain buffered RTT output captured since the last read (in ``data.text``)."""
        return _guard(lambda: sessions.get(session_id).read_rtt()).to_dict()

    @mcp.tool()
    def wait_for_rtt(
        session_id: str,
        pattern: str,
        timeout_s: float = 5.0,
        regex: bool = False,
        since_last_flash: bool = True,
    ) -> dict[str, Any]:
        """Block until ``pattern`` appears in the RTT stream, or ``timeout_s`` passes.

        Turns "flash and run" into a deterministic checkpoint: wait for a firmware
        banner or result line (e.g. "SELF-TEST PASS"). Requires RTT already started
        (start_rtt). Branch on ``data.matched`` (true if seen, false on timeout);
        the matched/preceding output is in ``data.text``. Set ``regex=True`` to treat
        ``pattern`` as a regular expression.

        ``since_last_flash`` (default True) discards output already buffered when the
        call begins, so a stale banner/result line from a previous image can't cause
        a false positive; only text arriving after this call is matched. flash_firmware
        and reset_target also auto-drain the buffer, so the fresh-image guarantee holds
        even without this. Pass False to also match already-buffered output.
        """
        return _guard(
            lambda: sessions.get(session_id).wait_for_rtt(
                pattern, timeout_s=timeout_s, regex=regex, since_last_flash=since_last_flash
            )
        ).to_dict()

    @mcp.tool()
    def stop_rtt(session_id: str) -> dict[str, Any]:
        """Stop background RTT log capture on a session."""
        return _guard(lambda: sessions.get(session_id).stop_rtt()).to_dict()

    @mcp.tool()
    def prepare_session(session_id: str) -> dict[str, Any]:
        """Reset session hygiene before a fresh run (discard stale RTT, bump epoch).

        Drains any buffered RTT output so the next ``wait_for_rtt`` cannot match text
        left over from a previous firmware image or an earlier loop iteration.
        The session stays open; use ``close_session`` to release the probe.
        """
        return _guard(lambda: sessions.get(session_id).prepare_for_run()).to_dict()
