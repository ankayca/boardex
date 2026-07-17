"""Tests for pure pyocd_ops helpers driven by a fake session. No hardware."""

from __future__ import annotations

import contextlib
import io

from boardex_target import pyocd_ops


class _FakeTarget:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read_memory_block8(self, address: int, length: int) -> list[int]:
        return list(self._data[:length])


class _FakeSession:
    def __init__(self, data: bytes) -> None:
        self.target = _FakeTarget(data)


def test_read_memory_echoes_requested_address_word_aligned():
    session = _FakeSession(b"\x01\x02\x03\x04")
    result = pyocd_ops.read_memory(session, 0x48000400, 4)

    assert result.ok
    assert result.data["address"] == 0x48000400
    assert result.data["requested_address"] == 0x48000400
    assert result.data["word_aligned"] is True
    assert result.data["hex"] == "01020304"
    assert result.warnings == []


def test_read_memory_warns_on_unaligned_peripheral_read():
    session = _FakeSession(b"\xaa\xbb")
    result = pyocd_ops.read_memory(session, 0x48000401, 2)

    assert result.data["requested_address"] == 0x48000401
    assert result.data["word_aligned"] is False
    assert result.warnings, "unaligned read should surface a word-access warning"


def test_flash_passes_a_silent_progress_callback(monkeypatch):
    """Regression (bench bring-up): pyOCD's default ``FileProgrammer`` writes
    flash progress bars (``[====...]``) to stdout. When this server runs as a
    stdio MCP server, stdout IS the JSON-RPC transport, so those bars corrupt
    the framing. ``flash`` must pass an explicit progress callback, and that
    callback must emit nothing to stdout."""
    captured: dict[str, object] = {}

    class _FakeProgrammer:
        def __init__(self, session, progress=None):
            captured["progress"] = progress

        def program(self, path):
            captured["path"] = path

    class _FlashTarget:
        def reset(self):
            captured["reset"] = True

    class _FlashSession:
        target = _FlashTarget()

    monkeypatch.setattr(pyocd_ops, "FileProgrammer", _FakeProgrammer)

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        result = pyocd_ops.flash(_FlashSession(), "/tmp/x.elf")

    assert result.ok
    progress = captured["progress"]
    assert callable(progress), "flash must pass an explicit (non-None) progress callback"
    # pyOCD calls the callback with a completion fraction; ours must be silent.
    with contextlib.redirect_stdout(buf):
        progress(0.0)
        progress(0.5)
        progress(1.0)
    assert buf.getvalue() == "", "progress callback must not write to stdout"
