"""Unit tests for the generic firmware builder. No board required.

Uses throwaway shell commands so we exercise the executor/verdict/diagnostic
logic without a real toolchain: a build is pass on exit 0, fail on non-zero, and
gcc-style errors are scraped into structured records.
"""

from __future__ import annotations

from pathlib import Path

from boardex_core import Verdict
from boardex_target import builder


def test_missing_project_dir_errors(tmp_path):
    result = builder.build_firmware(str(tmp_path / "nope"), command="true")
    assert result.verdict is Verdict.ERROR


def test_successful_build_finds_artifact(tmp_path: Path):
    # Command that "produces" an .elf; builder should discover it.
    result = builder.build_firmware(
        str(tmp_path), command="touch app.elf", artifact="app.elf"
    )
    assert result.verdict is Verdict.PASS
    assert result.data["artifact_path"].endswith("app.elf")
    assert result.data["returncode"] == 0


def test_failed_build_parses_gcc_error(tmp_path: Path):
    # Emit a gcc-style diagnostic on stderr and exit non-zero.
    cmd = ">&2 echo 'main.c:42:5: error: expected ; before }'; exit 2"
    result = builder.build_firmware(str(tmp_path), command=cmd)
    assert result.verdict is Verdict.FAIL
    assert result.data["returncode"] == 2
    errors = result.data["errors"]
    assert errors and errors[0]["file"] == "main.c"
    assert errors[0]["line"] == 42
    assert "expected ;" in errors[0]["message"]


def test_autodetect_makefile(tmp_path: Path):
    # A Makefile with a default target that just succeeds.
    (tmp_path / "Makefile").write_text("all:\n\t@true\n")
    result = builder.build_firmware(str(tmp_path))
    assert result.verdict is Verdict.PASS
    assert result.data["build_system"] == "make"
    assert result.data["command"] == "make"
