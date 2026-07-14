"""MCP stdio client host for the agent bench.

Connects to boardex-target and boardex-logic exactly the way the repo's editor
MCP config does (.cursor/mcp.json): spawn <repo-root>/.venv/bin/boardex-target
and .../boardex-logic over stdio. Tool schemas pass through to the model
unmodified (plus the harness-only optional _plan_index parameter, stripped
before dispatch). The servers are spawned only after plan approval
(RUNNER_AGENT_V0_SPEC §2: unapproved hardware access is unrepresentable).
"""

from __future__ import annotations

import json
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any, Protocol

from .meta_tools import PLAN_INDEX_PROP

SERVER_BINARIES = ("boardex-target", "boardex-logic")


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

    async def connect(self, venv_root: Path) -> None:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        self._stack = AsyncExitStack()
        for binary in SERVER_BINARIES:
            command = venv_root / ".venv" / "bin" / binary
            if not command.is_file():
                raise McpHostError(
                    f"{command} not found — install servers/{binary} into the repo .venv first"
                )
            params = StdioServerParameters(command=str(command), args=[])
            read, write = await self._stack.enter_async_context(stdio_client(params))
            session = await self._stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            listing = await session.list_tools()
            for tool in listing.tools:
                if tool.name in self._route:
                    raise McpHostError(f"tool name collision across servers: {tool.name}")
                self._route[tool.name] = session
                self.descriptions[tool.name] = tool.description or ""
                parameters = dict(tool.inputSchema or {"type": "object", "properties": {}})
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
