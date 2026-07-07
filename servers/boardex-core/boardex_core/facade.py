"""Shared plumbing for the MCP facade layer of every Boardex server.

Each domain server (target, logic, scope, ...) exposes coarse tools that must
always hand the agent a valid ``OperationResult`` — never a raised exception
across the MCP wire. The helpers here keep that behaviour identical in every
server instead of copy-pasting it.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from .errors import BoardexError
from .registry import BackendRegistry
from .results import OperationResult

log = logging.getLogger("boardex.facade")


def guard(
    fn: Callable[[], OperationResult],
    *,
    logger: logging.Logger | None = None,
) -> OperationResult:
    """Run an adapter call, converting expected failures into error results.

    Keeps every tool body a one-liner and guarantees the agent always receives
    a valid ``OperationResult`` instead of a raised exception across the MCP
    wire. Pass the server's own ``logger`` so failures show up under the right
    log namespace.
    """
    active_log = logger if logger is not None else log
    try:
        return fn()
    except BoardexError as exc:
        active_log.warning("operation failed: %s", exc)
        return OperationResult.errored(str(exc))
    except Exception as exc:  # noqa: BLE001 - last-resort safety net
        active_log.exception("unexpected error")
        return OperationResult.errored(f"Unexpected error: {exc}")


def list_devices_result(
    registry: BackendRegistry[Any], noun: str
) -> OperationResult:
    """Scan a registry and package the inventory as an ``OperationResult``.

    ``noun`` is the human-facing device kind used in the summary, e.g.
    ``"target"`` or ``"logic analyzer"``.
    """
    devices = registry.scan()
    return OperationResult.passed(
        f"Found {len(devices)} {noun}(s).",
        devices=[d.to_dict() for d in devices],
        backends=registry.available_backends(),
    )
