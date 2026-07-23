"""Tests for ELF/DWARF symbol resolution. No board required.

We compile a tiny program with the *host* toolchain (architecture-independent:
ElfInfo just reads .symtab and DWARF). ELF is the native object format on
Linux/BSD but not on macOS (Mach-O) or Windows (PE), so the suite skips unless
the host compiler actually emits ELF — checked by probing the magic bytes
rather than by hardcoding a platform list.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from boardex_target.elf import ElfInfo

_CC = shutil.which("cc") or shutil.which("gcc")


def _host_cc_emits_elf() -> bool:
    """True only if the host compiler produces an ELF binary (Linux/BSD)."""
    if _CC is None:
        return False
    try:
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "probe.c"
            src.write_text("int main(void) { return 0; }\n")
            out = Path(tmp) / "probe.bin"
            subprocess.run(
                [_CC, "-o", str(out), str(src)],
                check=True,
                capture_output=True,
            )
            return out.read_bytes()[:4] == b"\x7fELF"
    except (OSError, subprocess.SubprocessError):
        return False


pytestmark = pytest.mark.skipif(
    not _host_cc_emits_elf(),
    reason="host toolchain does not emit ELF (needs Linux/BSD cc/gcc)",
)


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


# -- inverse resolution (Phase 2: line -> address, location -> address) ----


def test_line_to_address_is_inverse_of_line_lookup(sample_elf):
    elf = ElfInfo.load(sample_elf)
    # helper is one line; resolve its entry to a (file, line), then invert it.
    info = elf.resolve_address(elf.symbol_address("helper"))
    addr = elf.line_to_address(info["file"], info["line"])
    assert addr is not None
    # The inverted address must resolve back to the same source line.
    assert elf.resolve_address(addr)["line"] == info["line"]


def test_line_to_address_matches_basename(sample_elf):
    elf = ElfInfo.load(sample_elf)
    info = elf.resolve_address(elf.symbol_address("main"))
    # A bare basename ("sample.c") resolves the same as the full path.
    assert elf.line_to_address("sample.c", info["line"]) is not None


def test_address_for_location_accepts_symbol_line_and_hex(sample_elf):
    elf = ElfInfo.load(sample_elf)
    by_symbol = elf.address_for_location("main")
    assert by_symbol == elf.symbol_address("main")

    info = elf.resolve_address(elf.symbol_address("helper"))
    by_line = elf.address_for_location(f"sample.c:{info['line']}")
    assert by_line is not None

    assert elf.address_for_location("0x08000abc") == 0x08000ABC
    assert elf.address_for_location("nonexistent_symbol_xyz") is None
