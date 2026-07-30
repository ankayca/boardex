"""MCP stdio client host for the agent bench.

Connects to boardex-target and boardex-logic over stdio, spawning the console
scripts from the *running interpreter's* scripts directory (the same place
``python -m`` / pipx / a repo ``.venv`` put ``boardex-runner`` itself). That
keeps packaged ``boardex up`` and a checkout venv on one path — never derive
the bin dir from ``BOARDEX_CONTRACT_SCHEMA_DIR`` / ``schema_dir()`` (those point
at a bundled schema copy inside site-packages under pipx).

The servers are spawned only after plan approval (RUNNER_AGENT_V0_SPEC §2:
unapproved hardware access is unrepresentable). Tool schemas pass through to
the model unmodified (plus the harness-only optional ``_plan_index``
parameter, stripped before dispatch).
"""

from __future__ import annotations

import json
import os
import sys
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any, Protocol

from .meta_tools import PLAN_INDEX_PROP

SERVER_BINARIES = ("boardex-target", "boardex-logic")


def scripts_dir(prefix: Path | None = None) -> Path:
    """Console-script directory for a Python prefix (POSIX bin/ vs Windows Scripts/)."""
    root = prefix if prefix is not None else Path(sys.prefix)
    if sys.platform == "win32":
        return root / "Scripts"
    return root / "bin"


def _venv_script(venv: Path, binary: str) -> Path:
    """Console-script path inside a venv prefix (kept for tests / call sites)."""
    return script_path(scripts_dir(venv), binary)


def script_path(bin_dir: Path, binary: str) -> Path:
    if sys.platform == "win32":
        return bin_dir / f"{binary}.exe"
    return bin_dir / binary


def default_mcp_bin_dir() -> Path:
    """Where ``boardex-target`` / ``boardex-logic`` console scripts live.

    Precedence:
    1. ``BOARDEX_MCP_BIN_DIR`` — explicit override for odd layouts;
    2. the running interpreter's scripts dir (``sys.prefix``) — correct for
       pipx, ``python -m`` out of a venv, and editable server installs.
    """
    override = os.environ.get("BOARDEX_MCP_BIN_DIR", "").strip()
    if override:
        return Path(override)
    return scripts_dir()


def tool_input_schema(tool: Any) -> dict[str, Any]:
    """MCP SDK ``Tool`` uses ``input_schema`` (alias ``inputSchema``); accept both."""
    schema = getattr(tool, "input_schema", None)
    if schema is None:
        schema = getattr(tool, "inputSchema", None)
    return dict(schema or {"type": "object", "properties": {}})


class ToolHost(Protocol):
    """What the agent loop needs from the MCP layer (real host or test fake)."""

    tool_specs: list[dict[str, Any]]
    descriptions: dict[str, str]

    def has_tool(self, name: str) -> bool: ...
    async def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]: ...
    async def close(self) -> None: ...


class McpHostError(Exception):
    pass


class McpToolHost:
    """Owns the stdio sessions and the tool-name -> session routing table."""

    def __init__(self) -> None:
        self._stack: AsyncExitStack | None = None
        self._route: dict[str, Any] = {}
        self.tool_specs: list[dict[str, Any]] = []  # OpenAI-format, model-facing
        self.descriptions: dict[str, str] = {}

    async def connect(self, bin_dir: Path | None = None) -> None:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        resolved = bin_dir if bin_dir is not None else default_mcp_bin_dir()
        self._stack = AsyncExitStack()
        for binary in SERVER_BINARIES:
            command = script_path(resolved, binary)
            if not command.is_file():
                raise McpHostError(
                    f"{command} not found — install {binary} into this environment "
                    f"(or set BOARDEX_MCP_BIN_DIR to a directory that contains it)"
                )
            params = StdioServerParameters(command=str(command), args=[])
            try:
                read, write = await self._stack.enter_async_context(stdio_client(params))
                session = await self._stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
                listing = await session.list_tools()
            except McpHostError:
                raise
            except Exception as exc:
                raise McpHostError(
                    f"failed to start {binary} from {command}: {type(exc).__name__}: {exc}"
                ) from exc
            for tool in listing.tools:
                if tool.name in self._route:
                    raise McpHostError(f"tool name collision across servers: {tool.name}")
                self._route[tool.name] = session
                self.descriptions[tool.name] = tool.description or ""
                parameters = tool_input_schema(tool)
                properties = dict(parameters.get("properties") or {})
                properties.update(PLAN_INDEX_PROP)
                parameters["properties"] = properties
                self.tool_specs.append(
                    {
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description or "",
                            "parameters": parameters,
                        },
                    }
                )

    def has_tool(self, name: str) -> bool:
        return name in self._route

    async def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        """Invoke the MCP tool; returns the structured result payload.

        Transport/protocol errors raise — the caller turns them into a visibly
        failed step (fail closed, spec §3.5).
        """
        session = self._route.get(name)
        if session is None:
            raise McpHostError(f"unknown MCP tool {name}")
        result = await session.call_tool(name, args)
        texts: list[str] = []
        for block in result.content or []:
            if getattr(block, "type", None) == "text":
                texts.append(block.text)
        joined = "\n".join(texts)
        if getattr(result, "isError", False):
            raise McpHostError(f"MCP tool {name} transport-level error: {joined[:2000]}")
        try:
            return json.loads(joined)
        except ValueError:
            return {"text": joined}

    async def close(self) -> None:
        if self._stack is not None:
            await self._stack.aclose()
            self._stack = None
