"""Tests for session-layer pure helpers. No board required."""

from __future__ import annotations

from boardex_target.session import _find_match


def test_find_match_plain_substring():
    text = "boot\nSELF-TEST PASS\nready\n"
    assert _find_match(text, "SELF-TEST PASS", regex=False) is not None
    assert _find_match(text, "NOPE", regex=False) is None


def test_find_match_returns_end_index():
    end = _find_match("abcXYZ", "XYZ", regex=False)
    assert end == 6  # index just past the match, for stream consumption


def test_find_match_regex():
    text = "temp=42C\ntemp=99C\n"
    assert _find_match(text, r"temp=\d+C", regex=True) is not None
    assert _find_match(text, r"volts=\d+", regex=True) is None
