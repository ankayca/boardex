"""Tests for session-layer pure helpers. No board required."""

from __future__ import annotations

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
    return _RttLogger(channel=None)


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
    ms = ManagedSession("sess-1", "pyocd:test", native=None, target=None)
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


# -- vendor-neutral session layer ------------------------------------------


class _FakeChannel:
    name = "Terminal"

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    def read(self) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""


class _FakeNativeSession:
    def __init__(self, channel: _FakeChannel | None = None) -> None:
        self.closed = False
        self._channel = channel

    def run(self, operation):
        return operation("fake-vendor-session")

    def open_rtt(self, *, control_block_address: int | None = None):
        from boardex_core import RttUnavailableError

        if self._channel is None:
            raise RttUnavailableError("no RTT on this fake target")
        return self._channel

    def close(self) -> None:
        self.closed = True


class _FakeSessionAdapter:
    """SupportsSessions implementation with no vendor SDK behind it."""

    def __init__(self, native: _FakeNativeSession) -> None:
        self._native = native

    def probe_unique_id(self, device_id: str) -> str:
        return device_id.split(":", 1)[-1]

    def open_native_session(self, device_id: str, *, target: str | None = None):
        return self._native


def test_session_manager_opens_via_adapter_capability():
    from boardex_core import SupportsSessions
    from boardex_target.session import SessionManager

    native = _FakeNativeSession()
    adapter = _FakeSessionAdapter(native)
    assert isinstance(adapter, SupportsSessions)

    manager = SessionManager()
    managed = manager.open(adapter, "fake:42", target=None)
    assert managed.device_id == "fake:42"

    manager.close(managed.session_id)
    assert native.closed


def test_start_rtt_reports_inconclusive_when_unavailable():
    session = ManagedSession(
        "sess-1", "fake:42", native=_FakeNativeSession(channel=None), target=None
    )
    result = session.start_rtt()
    assert result.verdict.value == "inconclusive"
    assert "no RTT" in result.summary


def test_rtt_streams_through_fake_channel():
    channel = _FakeChannel([b"hello ", b"world\n"])
    session = ManagedSession(
        "sess-1", "fake:42", native=_FakeNativeSession(channel), target=None
    )
    start = session.start_rtt()
    assert start.ok
    try:
        result = session.wait_for_rtt("world", timeout_s=2.0, since_last_flash=False)
        assert result.data["matched"] is True
    finally:
        session.stop_rtt()


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
