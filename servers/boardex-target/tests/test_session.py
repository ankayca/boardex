"""Tests for session-layer pure helpers. No board required."""

from __future__ import annotations

import threading

from boardex_target.session import ManagedSession, _find_match, _RttLogger


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


# -- RTT backlog discard (stale-match fix) --------------------------------


def _idle_logger() -> _RttLogger:
    """An _RttLogger with no thread running, safe to poke buffers directly."""
    return _RttLogger(session=None, lock=threading.RLock())


def test_rtt_logger_discard_clears_buffer_and_reports_count():
    logger = _idle_logger()
    logger._append(b"stale SELF-TEST PASS\n")
    assert logger.buffered_bytes() > 0

    dropped = logger.discard()

    assert dropped == len(b"stale SELF-TEST PASS\n")
    assert logger.buffered_bytes() == 0
    # A following drain sees nothing left over.
    data, _total, _dropped = logger.drain()
    assert data == b""


def _session_with(logger: _RttLogger | None) -> ManagedSession:
    ms = ManagedSession("sess-1", "pyocd:test", session=None, target=None)
    ms._rtt = logger
    return ms


def test_discard_rtt_backlog_is_noop_without_stream():
    assert _session_with(None).discard_rtt_backlog() == 0


def test_discard_rtt_backlog_drops_previous_image_output():
    logger = _idle_logger()
    logger._append(b"old image: SELF-TEST PASS\n")
    session = _session_with(logger)

    assert session.discard_rtt_backlog() > 0
    assert logger.buffered_bytes() == 0


class _FakeRtt:
    """Minimal stand-in for _RttLogger used to drive wait_for_rtt logic."""

    def __init__(self, pending: bytes) -> None:
        self._pending = pending
        self.channel_name = "Terminal"
        self.running = True

    def discard(self) -> int:
        dropped = len(self._pending)
        self._pending = b""
        return dropped

    def drain(self) -> tuple[bytes, int, int]:
        data, self._pending = self._pending, b""
        return data, 0, 0


def test_wait_for_rtt_ignores_stale_buffer_by_default():
    # Only stale output is buffered; since_last_flash (default) drops it, so the
    # pattern must NOT match and the call reports a timeout.
    session = _session_with(_FakeRtt(b"SELF-TEST PASS\n"))
    result = session.wait_for_rtt("SELF-TEST PASS", timeout_s=0.1)
    assert result.data["matched"] is False
    assert result.data["timed_out"] is True


def test_wait_for_rtt_matches_stale_buffer_when_opted_in():
    session = _session_with(_FakeRtt(b"SELF-TEST PASS\n"))
    result = session.wait_for_rtt(
        "SELF-TEST PASS", timeout_s=0.1, since_last_flash=False
    )
    assert result.data["matched"] is True
    assert result.data["timed_out"] is False


def test_prepare_for_run_discards_and_bumps_epoch():
    logger = _idle_logger()
    logger._append(b"stale\n")
    session = _session_with(logger)
    assert session._run_epoch == 0

    result = session.prepare_for_run()

    assert result.ok
    assert result.data["rtt_backlog_discarded"] == len(b"stale\n")
    assert result.data["run_epoch"] == 1
    assert logger.buffered_bytes() == 0
