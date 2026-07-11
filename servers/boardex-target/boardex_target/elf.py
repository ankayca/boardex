"""ELF/DWARF symbol resolution: turn raw target addresses into source locations.

This is what makes crash reports and RTT discovery *agent-actionable*: instead of
"crashed at 0x08000abc" the agent gets "crashed in ``i2c_write`` at ``i2c.c:42``",
and RTT auto-locates its control block from the firmware's ``_SEGGER_RTT`` symbol
instead of scanning RAM.

It is brand-neutral (standard ELF, produced by any GCC/Clang/IAR toolchain) and
host-side (no probe needed), so it lives here as a helper rather than on the
``TargetController`` contract. Parsing is best-effort: a stripped or debug-info-
free binary still yields function names from ``.symtab`` (address -> ``func+off``);
DWARF adds ``file:line`` on top when present.
"""

from __future__ import annotations

import bisect
import os
from dataclasses import dataclass
from typing import Any

try:
    from elftools.elf.elffile import ELFFile

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001
    ELFFile = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


@dataclass(frozen=True)
class _Func:
    addr: int  # thumb bit masked off
    size: int
    name: str


class ElfInfo:
    """Parsed symbol + line information for one ELF image.

    Constructed via :meth:`load`, which caches by (path, mtime) so repeated
    status/RTT calls after a single flash don't re-parse the file.
    """

    _cache: dict[tuple[str, float], "ElfInfo | None"] = {}

    def __init__(self, path: str) -> None:
        self.path = path
        self._names: dict[str, int] = {}
        self._funcs: list[_Func] = []
        self._func_addrs: list[int] = []
        # Sorted (address, filename, line) rows from the DWARF line program.
        self._lines: list[tuple[int, str, int]] = []
        self._line_addrs: list[int] = []
        self._parse()

    @classmethod
    def load(cls, path: str | None) -> "ElfInfo | None":
        """Parse ``path`` (or return None if missing/unreadable/not an ELF)."""
        if not path or _IMPORT_ERROR is not None:
            return None
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            return None
        key = (path, mtime)
        if key not in cls._cache:
            try:
                cls._cache[key] = cls(path)
            except Exception:  # noqa: BLE001 - a bad ELF must never break a tool
                cls._cache[key] = None
        return cls._cache[key]

    # -- public API --------------------------------------------------------

    def symbol_address(self, name: str) -> int | None:
        """Address of a named symbol (e.g. ``_SEGGER_RTT``), or None."""
        return self._names.get(name)

    def line_to_address(self, file: str, line: int) -> int | None:
        """Address of the first machine instruction for ``file:line`` (inverse of
        :meth:`resolve_address`'s line lookup).

        Matches ``file`` against the tail of each DWARF filename (so ``i2c.c`` or
        ``src/i2c.c`` both resolve). Prefers an exact line match; if the compiler
        emitted no row for that exact line (dead/optimised code), falls back to the
        first row at a line at or after it. Returns the lowest address among ties.
        """
        base = os.path.basename(file)
        exact: list[int] = []
        after: list[tuple[int, int]] = []  # (row_line, address) for row_line >= line
        for addr, filename, row_line in self._lines:
            fn = filename
            if not (fn == file or fn.endswith("/" + base) or fn == base or fn.endswith(file)):
                continue
            if row_line == line:
                exact.append(addr)
            elif row_line > line:
                after.append((row_line, addr))
        if exact:
            return min(exact)
        if after:
            # nearest line at/after the request, then lowest address for that line
            nearest = min(row_line for row_line, _ in after)
            return min(addr for row_line, addr in after if row_line == nearest)
        return None

    def address_for_location(self, location: str) -> int | None:
        """Resolve a human ``location`` to a code address (best effort).

        Accepts, in order: a raw address (``0x08000abc``, ``134218842``), a
        ``file:line`` reference (``i2c.c:42``), or a symbol name (``i2c_write``).
        Returns None if nothing resolves. This is what lets an agent set a
        breakpoint on a name it can see in source instead of a raw PC.
        """
        text = location.strip()
        if not text:
            return None
        # Raw address: 0x-prefixed hex, or a bare integer that is not a file:line.
        if text.lower().startswith("0x"):
            try:
                return int(text, 16)
            except ValueError:
                return None
        if ":" in text:
            file_part, _, line_part = text.rpartition(":")
            if file_part and line_part.isdigit():
                return self.line_to_address(file_part, int(line_part))
            return None
        if text.isdigit():
            return int(text)
        return self.symbol_address(text)

    def resolve_address(self, address: int) -> dict[str, Any] | None:
        """Map a code address to ``{symbol, offset, file, line}`` (best effort).

        Returns None if the address falls outside every known function. The
        Thumb bit (LSB) is masked, so a raw PC or a symbol value both resolve.
        """
        addr = address & ~1
        func = self._function_containing(addr)
        result: dict[str, Any] = {"address": address}
        if func is not None:
            result["symbol"] = func.name
            result["offset"] = addr - func.addr
        file_line = self._line_for(addr)
        if file_line is not None:
            result["file"], result["line"] = file_line
        if "symbol" not in result and "file" not in result:
            return None
        return result

    def describe(self, address: int) -> str:
        """One-line human form, e.g. ``i2c_write+0x12 (i2c.c:42)``."""
        info = self.resolve_address(address)
        if info is None:
            return f"{address:#010x} (no symbol)"
        text = info.get("symbol", f"{address:#010x}")
        if "offset" in info and info["offset"]:
            text += f"+{info['offset']:#x}"
        if "file" in info:
            text += f" ({info['file']}:{info['line']})"
        return text

    # -- parsing -----------------------------------------------------------

    def _parse(self) -> None:
        with open(self.path, "rb") as stream:
            elf = ELFFile(stream)
            self._parse_symbols(elf)
            if elf.has_dwarf_info():
                try:
                    self._parse_lines(elf)
                except Exception:  # noqa: BLE001 - line info is a bonus, not required
                    self._lines = []
        self._funcs.sort(key=lambda f: f.addr)
        self._func_addrs = [f.addr for f in self._funcs]
        self._lines.sort(key=lambda row: row[0])
        self._line_addrs = [row[0] for row in self._lines]

    def _parse_symbols(self, elf: Any) -> None:
        symtab = elf.get_section_by_name(".symtab") or elf.get_section_by_name(
            ".dynsym"
        )
        if symtab is None:
            return
        for sym in symtab.iter_symbols():
            if not sym.name:
                continue
            value = int(sym["st_value"])
            # First definition wins; keeps _SEGGER_RTT et al. stable.
            self._names.setdefault(sym.name, value)
            if sym["st_info"]["type"] == "STT_FUNC":
                self._funcs.append(_Func(value & ~1, int(sym["st_size"]), sym.name))

    def _parse_lines(self, elf: Any) -> None:
        dwarf = elf.get_dwarf_info()
        for cu in dwarf.iter_CUs():
            line_program = dwarf.line_program_for_CU(cu)
            if line_program is None:
                continue
            for entry in line_program.get_entries():
                state = entry.state
                if state is None or state.end_sequence:
                    continue
                filename = self._filename(line_program, state.file)
                self._lines.append((state.address, filename, state.line))

    @staticmethod
    def _filename(line_program: Any, file_index: int) -> str:
        """Resolve a line-program file index to a name across DWARF versions."""
        try:
            entries = line_program["file_entry"]
            version = line_program.header.get("version", 4)
            # DWARF <5 file table is 1-based (index 0 is the CU's own file);
            # DWARF 5 is 0-based.
            idx = file_index if version >= 5 else file_index - 1
            name = entries[idx].name
            return name.decode() if isinstance(name, bytes) else str(name)
        except Exception:  # noqa: BLE001
            return "?"

    def _function_containing(self, addr: int) -> _Func | None:
        pos = bisect.bisect_right(self._func_addrs, addr) - 1
        if pos < 0:
            return None
        func = self._funcs[pos]
        # A zero-size symbol (common for asm) can't bound-check; accept it as the
        # nearest preceding function.
        if func.size and addr >= func.addr + func.size:
            return None
        return func

    def _line_for(self, addr: int) -> tuple[str, int] | None:
        if not self._line_addrs:
            return None
        pos = bisect.bisect_right(self._line_addrs, addr) - 1
        if pos < 0:
            return None
        _, filename, line = self._lines[pos]
        return filename, line
