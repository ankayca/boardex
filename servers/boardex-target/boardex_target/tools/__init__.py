"""Agent-facing MCP tools for boardex-target, grouped by concern.

Each module exposes ``register(mcp, ...)`` which defines its tools onto the
shared ``FastMCP`` instance. ``server.py`` calls them in a fixed order so the
tool list the agent sees is stable.
"""

from __future__ import annotations

import logging
from typing import Callable

from boardex_core import OperationResult, guard

log = logging.getLogger("boardex.target")


def guarded(fn: Callable[[], OperationResult]) -> OperationResult:
    """Shared facade guard bound to this server's logger."""
    return guard(fn, logger=log)
