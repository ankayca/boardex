"""Unit tests for the generic firmware builder. No board required.

Uses throwaway commands built on ``sys.executable`` (portable across Linux,
macOS, and Windows shells) so we exercise the executor/verdict/diagnostic
logic without a real toolchain: a build is pass on exit 0, fail on non-zero,
and gcc-style errors are scraped into structured records.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

from boardex_core import Verdict
from boardex_target import builder


def _py(script: str) -> str:
    """A shell command running ``script`` under this Python (sh and cmd safe)."""
    return f'"{sys.executable}" -c "{script}"'


def test_missing_project_dir_errors(tmp_path):
    result = builder.build_firmware(str(tmp_path / "nope"), command=_py("pass"))
    assert result.verdict is Verdict.ERROR


def test_successful_build_finds_artifact(tmp_path: Path):
    # Command that "produces" an .elf; builder should discover it.
    result = builder.build_firmware(
        str(tmp_path),
        command=_py("import pathlib; pathlib.Path('app.elf').touch()"),
        artifact="app.elf",
    )
    assert result.verdict is Verdict.PASS
    assert result.data["artifact_path"].endswith("app.elf")
    assert result.data["returncode"] == 0


def test_failed_build_parses_gcc_error(tmp_path: Path):
    # Emit a gcc-style diagnostic on stderr and exit non-zero.
    script = (
        "import sys; "
        "sys.stderr.write('main.c:42:5: error: expected ; before }\\n'); "
        "sys.exit(2)"
    )
    result = builder.build_firmware(str(tmp_path), command=_py(script))
    assert result.verdict is Verdict.FAIL
    assert result.data["returncode"] == 2
    errors = result.data["errors"]
    assert errors and errors[0]["file"] == "main.c"
    assert errors[0]["line"] == 42
    assert "expected ;" in errors[0]["message"]


@pytest.mark.skipif(
    shutil.which("make") is None or sys.platform == "win32",
    reason="needs GNU make with a POSIX shell for recipes",
)
def test_autodetect_makefile(tmp_path: Path):
    # A Makefile with a default target that just succeeds.
    (tmp_path / "Makefile").write_text("all:\n\t@true\n")
    result = builder.build_firmware(str(tmp_path))
    assert result.verdict is Verdict.PASS
    assert result.data["build_system"] == "make"
    assert result.data["command"] == "make"
