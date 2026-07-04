"""boardex-target MCP server: the agent-facing facade for flashing & debugging.

Layer 4 of the Boardex architecture (see docs/ARCHITECTURE.md). Tools here are
coarse-grained and always return a structured ``OperationResult`` dict so the
agent's flash -> test -> verify loop can branch on a machine-readable verdict.

Tools never touch hardware directly: they go through the ``BackendRegistry`` to
whichever adapter owns the requested ``device_id``.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

from boardex_core import BackendRegistry, BoardexError, OperationResult, TargetController
from mcp.server.fastmcp import FastMCP

from .adapters.pyocd_adapter import PyOcdAdapter
from .session import SessionManager

log = logging.getLogger("boardex.target")

mcp = FastMCP("boardex-target")

# Owns persistent debug sessions (for RTT streaming, etc.). Shared with the
# adapter so stateless tools transparently reuse an open session when one exists.
sessions = SessionManager()

# Registry of target-control backends. Register new probes (J-Link, OpenOCD, ...)
# here and they immediately appear in list_targets() with no tool changes.
registry: BackendRegistry[TargetController] = BackendRegistry()
registry.register("pyocd", lambda: PyOcdAdapter(sessions))


def _guard(fn: Any) -> OperationResult:
    """Run an adapter call, converting expected failures into error results.

    Keeps every tool body a one-liner and guarantees the agent always receives a
    valid ``OperationResult`` instead of a raised exception across the MCP wire.
    """
    try:
        return fn()
    except BoardexError as exc:
        log.warning("operation failed: %s", exc)
        return OperationResult.errored(str(exc))
    except Exception as exc:  # noqa: BLE001 - last-resort safety net
        log.exception("unexpected error")
        return OperationResult.errored(f"Unexpected error: {exc}")


@mcp.tool()
def list_targets() -> dict[str, Any]:
    """List every debug probe / MCU target currently connected to the bench.

    Returns a result whose ``data.devices`` is a list of device descriptors. Use
    each device's ``device_id`` in the other tools.
    """
    devices = registry.scan()
    return OperationResult.passed(
        f"Found {len(devices)} target(s).",
        devices=[d.to_dict() for d in devices],
        backends=registry.available_backends(),
    ).to_dict()


@mcp.tool()
def flash_firmware(
    device_id: str,
    firmware_path: str,
    target: str | None = None,
    verify: bool = True,
    reset_after: bool = True,
) -> dict[str, Any]:
    """Flash a firmware image (.elf/.hex/.bin) onto a target and reset it.

    Args:
        device_id: Id from ``list_targets`` (e.g. "pyocd:0670FF...").
        firmware_path: Absolute path to the firmware image on this machine.
        target: MCU part number (e.g. "stm32f411re"). Often required for ST-Link
            probes that cannot auto-detect the connected die.
        verify: Verify flash contents after programming.
        reset_after: Reset the target once programming completes.
    """
    return _guard(
        lambda: registry.resolve(device_id).flash(
            device_id,
            firmware_path,
            target=target,
            verify=verify,
            reset_after=reset_after,
        )
    ).to_dict()


@mcp.tool()
def reset_target(
    device_id: str, target: str | None = None, halt: bool = False
) -> dict[str, Any]:
    """Reset a target. Set ``halt=True`` to stop the core right after reset."""
    return _guard(
        lambda: registry.resolve(device_id).reset(device_id, target=target, halt=halt)
    ).to_dict()


@mcp.tool()
def halt_target(device_id: str, target: str | None = None) -> dict[str, Any]:
    """Halt the target's CPU core."""
    return _guard(
        lambda: registry.resolve(device_id).halt(device_id, target=target)
    ).to_dict()


@mcp.tool()
def resume_target(device_id: str, target: str | None = None) -> dict[str, Any]:
    """Resume the target's CPU core."""
    return _guard(
        lambda: registry.resolve(device_id).resume(device_id, target=target)
    ).to_dict()


@mcp.tool()
def read_memory(
    device_id: str, address: int, length: int, target: str | None = None
) -> dict[str, Any]:
    """Read ``length`` bytes from ``address``; returns hex in ``data.hex``."""
    return _guard(
        lambda: registry.resolve(device_id).read_memory(
            device_id, address, length, target=target
        )
    ).to_dict()


@mcp.tool()
def write_memory(
    device_id: str, address: int, hex_data: str, target: str | None = None
) -> dict[str, Any]:
    """Write bytes (given as a hex string, e.g. "deadbeef") to ``address``."""
    try:
        data = bytes.fromhex(hex_data)
    except ValueError as exc:
        return OperationResult.errored(f"Invalid hex_data: {exc}").to_dict()
    return _guard(
        lambda: registry.resolve(device_id).write_memory(
            device_id, address, data, target=target
        )
    ).to_dict()


@mcp.tool()
def read_firmware_log(
    device_id: str,
    target: str | None = None,
    timeout_s: float = 2.0,
    control_block_address: int | None = None,
) -> dict[str, Any]:
    """Read firmware debug output over SEGGER RTT for up to ``timeout_s`` seconds.

    Attaches to the running core and drains the RTT up channel into ``data.text``.
    Pass ``control_block_address`` (the ``_SEGGER_RTT`` symbol address) to skip
    the RAM search. Returns verdict ``inconclusive`` if the firmware isn't using
    RTT.
    """
    return _guard(
        lambda: registry.resolve(device_id).read_log(
            device_id,
            target=target,
            timeout_s=timeout_s,
            control_block_address=control_block_address,
        )
    ).to_dict()


# -- persistent debug sessions --------------------------------------------


@mcp.tool()
def open_session(device_id: str, target: str | None = None) -> dict[str, Any]:
    """Open a persistent debug session for a target and keep the probe claimed.

    Required before RTT streaming. While a session is open, the plain tools
    (flash_firmware, reset_target, read_memory, ...) automatically route through
    it. Returns ``data.session_id`` for use with the RTT tools and close_session.
    """

    def _open() -> OperationResult:
        adapter = registry.resolve(device_id)
        uid = adapter.probe_unique_id(device_id)  # type: ignore[attr-defined]
        managed = sessions.open(device_id, uid, target=target)
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
def start_rtt(session_id: str, control_block_address: int | None = None) -> dict[str, Any]:
    """Start background RTT log capture on an open session.

    A reader thread continuously drains the RTT up channel into a buffer; use
    ``read_rtt`` to fetch accumulated output. Pass ``control_block_address``
    (the ``_SEGGER_RTT`` symbol) to skip the RAM search.
    """
    return _guard(
        lambda: sessions.get(session_id).start_rtt(
            control_block_address=control_block_address
        )
    ).to_dict()


@mcp.tool()
def read_rtt(session_id: str) -> dict[str, Any]:
    """Drain buffered RTT output captured since the last read (in ``data.text``)."""
    return _guard(lambda: sessions.get(session_id).read_rtt()).to_dict()


@mcp.tool()
def stop_rtt(session_id: str) -> dict[str, Any]:
    """Stop background RTT log capture on a session."""
    return _guard(lambda: sessions.get(session_id).stop_rtt()).to_dict()


def main() -> None:
    """Console entry point: run the server over stdio (how MCP clients spawn it).

    Logs go to stderr (stdout is reserved for the JSON-RPC transport). pyOCD is
    very chatty at INFO, so we quiet it to WARNING to keep the wire clean.
    """
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    logging.getLogger("pyocd").setLevel(logging.WARNING)
    mcp.run()


if __name__ == "__main__":
    main()
