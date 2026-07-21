"""Host-side path resolution for the MCP stdio servers (no MCP needed)."""

from __future__ import annotations

from pathlib import Path

from boardex_runner import mcp_host


def test_venv_script_layout_matches_platform(monkeypatch):
    venv = Path("/x/.venv")

    monkeypatch.setattr(mcp_host.sys, "platform", "linux")
    assert mcp_host._venv_script(venv, "boardex-target") == venv / "bin" / "boardex-target"

    monkeypatch.setattr(mcp_host.sys, "platform", "win32")
    assert (
        mcp_host._venv_script(venv, "boardex-target")
        == venv / "Scripts" / "boardex-target.exe"
    )
