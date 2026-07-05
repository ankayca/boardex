"""Tests for pure pyocd_ops helpers driven by a fake session. No hardware."""

from __future__ import annotations

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
