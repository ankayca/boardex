"""Harness-local workspace tools.

NOT part of the MCP servers: boardex-target/boardex-logic expose no file
editing (confirmed by audit — the runner bench is "no code editing" by
design), and the spec's predecessor proof ran inside Cursor, which supplied
file tools itself. The spike stands in for that host layer with a minimal,
--repo-scoped set: list_files / read_file / write_file. write_file yields the
contract's code_diff artifact content ({files: [{path, reason, diff}]},
packages/contract/src/artifacts.ts) so edits render in the UI diff viewer.
"""

from __future__ import annotations

import difflib
import json
from pathlib import Path
from typing import Any

from .meta_tools import PLAN_INDEX_PROP

READ_CAP_BYTES = 64_000
LIST_CAP = 500

WORKSPACE_TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    "list_files": {
        "description": "List files in the task repo (relative paths). Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Subdirectory to list; default repo root."},
                **PLAN_INDEX_PROP,
            },
            "additionalProperties": False,
        },
    },
    "read_file": {
        "description": "Read a text file from the task repo. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                **PLAN_INDEX_PROP,
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    "write_file": {
        "description": (
            "Write the full new content of a file in the task repo. Provide a one-line "
            "reason explaining the change; the harness records a code_diff artifact."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
                "reason": {"type": "string", "description": "One-line rationale shown per file in the UI."},
                **PLAN_INDEX_PROP,
            },
            "required": ["path", "content", "reason"],
            "additionalProperties": False,
        },
    },
}

WORKSPACE_TOOL_NAMES = frozenset(WORKSPACE_TOOL_SCHEMAS)


class WorkspaceError(Exception):
    pass


class Workspace:
    def __init__(self, repo: Path) -> None:
        self.repo = Path(repo).resolve()
        if not self.repo.is_dir():
            raise WorkspaceError(f"--repo {self.repo} is not a directory")
        # Files the agent changed since the last approval gate (Approval.filesChanged).
        self.edited_since_gate: list[str] = []

    def _resolve(self, rel: str) -> Path:
        candidate = (self.repo / rel).resolve()
        if candidate != self.repo and self.repo not in candidate.parents:
            raise WorkspaceError(f"path {rel!r} escapes the task repo")
        return candidate

    def list_files(self, path: str = ".") -> dict[str, Any]:
        base = self._resolve(path or ".")
        if not base.is_dir():
            raise WorkspaceError(f"{path!r} is not a directory")
        entries = sorted(
            str(p.relative_to(self.repo)) + ("/" if p.is_dir() else "")
            for p in base.rglob("*")
            if not any(part.startswith(".") for part in p.relative_to(self.repo).parts)
        )
        return {"files": entries[:LIST_CAP], "truncated": len(entries) > LIST_CAP}

    def read_file(self, path: str) -> dict[str, Any]:
        target = self._resolve(path)
        if not target.is_file():
            raise WorkspaceError(f"{path!r} does not exist")
        data = target.read_bytes()
        text = data[:READ_CAP_BYTES].decode("utf-8", errors="replace")
        return {"path": path, "content": text, "truncated": len(data) > READ_CAP_BYTES}

    def write_file(self, path: str, content: str, reason: str) -> dict[str, Any]:
        """Write and return the code_diff artifact content for this edit."""
        target = self._resolve(path)
        before = target.read_text(errors="replace") if target.is_file() else ""
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        diff = "".join(
            difflib.unified_diff(
                before.splitlines(keepends=True),
                content.splitlines(keepends=True),
                fromfile=f"a/{path}",
                tofile=f"b/{path}",
            )
        )
        if path not in self.edited_since_gate:
            self.edited_since_gate.append(path)
        diff_content = {"files": [{"path": path, "reason": reason, "diff": diff}]}
        return {
            "result": {"path": path, "bytes_written": len(content.encode())},
            "code_diff": diff_content,
        }

    def dispatch(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == "list_files":
            return self.list_files(args.get("path", "."))
        if name == "read_file":
            return self.read_file(args["path"])
        if name == "write_file":
            return self.write_file(args["path"], args["content"], args["reason"])
        raise WorkspaceError(f"unknown workspace tool {name}")

    def tree_snapshot(self, max_entries: int = 80) -> str:
        listing = self.list_files(".")["files"][:max_entries]
        return "\n".join(listing)


def workspace_tools_as_openai() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": spec["description"],
                "parameters": spec["parameters"],
            },
        }
        for name, spec in WORKSPACE_TOOL_SCHEMAS.items()
    ]


def diff_artifact_bytes(diff_content: dict[str, Any]) -> bytes:
    return json.dumps(diff_content, indent=2).encode()
