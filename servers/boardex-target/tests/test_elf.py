"""Tests for ELF/DWARF symbol resolution. No board required.

We compile a tiny program with the *host* toolchain (architecture-independent:
ElfInfo just reads .symtab and DWARF), so the test is portable wherever a C
compiler exists and skips cleanly otherwise.
"""

from __future__ import annotations

import shutil
import subprocess

import pytest

from boardex_target.elf import ElfInfo

_CC = shutil.which("cc") or shutil.which("gcc")

pytestmark = pytest.mark.skipif(_CC is None, reason="no host C compiler available")


@pytest.fixture()
def sample_elf(tmp_path):
    src = tmp_path / "sample.c"
    src.write_text(
        "int helper(int x) { return x + 1; }\n"
        "int main(void) { return helper(41); }\n"
    )
    out = tmp_path / "sample.elf"
    subprocess.run(
        [_CC, "-g", "-O0", "-no-pie", "-o", str(out), str(src)],
        check=True,
        capture_output=True,
    )
    return str(out)


def test_symbol_address_and_roundtrip(sample_elf):
    elf = ElfInfo.load(sample_elf)
    assert elf is not None
    addr = elf.symbol_address("main")
    assert addr is not None
    info = elf.resolve_address(addr)
    assert info is not None
    assert info["symbol"] == "main"


def test_resolve_reports_source_line(sample_elf):
    elf = ElfInfo.load(sample_elf)
    info = elf.resolve_address(elf.symbol_address("helper"))
    assert info["symbol"] == "helper"
    # -g emitted DWARF, so we should get the source file back.
    assert info.get("file", "").endswith("sample.c")
    assert isinstance(info.get("line"), int)


def test_describe_is_human_readable(sample_elf):
    elf = ElfInfo.load(sample_elf)
    text = elf.describe(elf.symbol_address("main"))
    assert "main" in text


def test_load_returns_none_for_missing_or_nonelf(tmp_path):
    assert ElfInfo.load(None) is None
    assert ElfInfo.load(str(tmp_path / "nope.elf")) is None
    junk = tmp_path / "junk.elf"
    junk.write_text("not an elf")
    assert ElfInfo.load(str(junk)) is None
