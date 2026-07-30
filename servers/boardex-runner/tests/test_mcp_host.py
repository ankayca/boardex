"""Host-side path resolution for the MCP stdio servers (no MCP needed)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

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


def test_default_mcp_bin_dir_uses_sys_prefix_scripts(monkeypatch, tmp_path: Path):
    monkeypatch.delenv("BOARDEX_MCP_BIN_DIR", raising=False)
    monkeypatch.setattr(mcp_host.sys, "prefix", str(tmp_path))
    monkeypatch.setattr(mcp_host.sys, "platform", "linux")
    assert mcp_host.default_mcp_bin_dir() == tmp_path / "bin"


def test_default_mcp_bin_dir_honors_env_override(monkeypatch, tmp_path: Path):
    override = tmp_path / "custom-bin"
    monkeypatch.setenv("BOARDEX_MCP_BIN_DIR", str(override))
    assert mcp_host.default_mcp_bin_dir() == override


def test_tool_input_schema_accepts_sdk_attr_and_wire_alias():
    assert mcp_host.tool_input_schema(SimpleNamespace(input_schema={"type": "object"})) == {
        "type": "object"
    }
    assert mcp_host.tool_input_schema(SimpleNamespace(inputSchema={"type": "object"})) == {
        "type": "object"
    }
    assert mcp_host.tool_input_schema(SimpleNamespace()) == {
        "type": "object",
        "properties": {},
    }


def test_mcp_bin_dir_ignores_contract_schema_env(monkeypatch, tmp_path: Path):
    """Packaged ``boardex up`` sets BOARDEX_CONTRACT_SCHEMA_DIR to a bundled
    copy under site-packages — that must NOT become the MCP bin parent (the
    bug that left hardware tools unbound after plan approval)."""
    bundled = tmp_path / "site-packages" / "boardex_app" / "_bundled" / "contract-schema"
    bundled.mkdir(parents=True)
    prefix = tmp_path / "pipx-venv"
    (prefix / "bin").mkdir(parents=True)
    monkeypatch.setenv("BOARDEX_CONTRACT_SCHEMA_DIR", str(bundled))
    monkeypatch.delenv("BOARDEX_MCP_BIN_DIR", raising=False)
    monkeypatch.setattr(mcp_host.sys, "prefix", str(prefix))
    monkeypatch.setattr(mcp_host.sys, "platform", "linux")
    assert mcp_host.default_mcp_bin_dir() == prefix / "bin"
