"""boardex-target MCP server: the agent-facing facade for flashing & debugging.

Layer 4 of the Boardex architecture (see docs/ARCHITECTURE.md). This module is
assembly only: it builds the backend registry from installed plugins, owns the
session manager, and registers the tool groups (defined under ``tools/``) onto
the FastMCP instance in a fixed order.

Tools are coarse-grained and always return a structured ``OperationResult``
dict so the agent's flash -> test -> verify loop can branch on a
machine-readable verdict. Tools never touch hardware directly: they go through
the ``BackendRegistry`` to whichever adapter owns the requested ``device_id``.
"""

from __future__ import annotations

import logging
import sys

from boardex_core import BackendRegistry, TargetController
from mcp.server.fastmcp import FastMCP

from .backends import build_registry
from .session import SessionManager
from .tools import composite, sessions as session_tools, target_ops

log = logging.getLogger("boardex.target")

mcp = FastMCP("boardex-target")

# Owns persistent debug sessions (for RTT streaming, etc.). Shared with the
# adapters so stateless tools transparently reuse an open session when one exists.
sessions = SessionManager()

# Registry of target-control backends, assembled from installed plugins
# (``boardex.target_backends`` entry points). New probes (J-Link, OpenOCD, ...)
# appear in list_targets() by pip-installing their adapter package.
registry: BackendRegistry[TargetController] = build_registry(sessions)

# Registration order is part of the agent-facing surface; keep it stable.
target_ops.register(mcp, registry)
session_tools.register(mcp, registry, sessions)
composite.register(mcp, registry, sessions)


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
