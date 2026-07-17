"""Command-shape tests for the isolated sigrok-cli wrapper."""

from __future__ import annotations

import sys
import time

import pytest

from boardex_core import OperationFailedError
from boardex_logic import sigrok_cli


def _fake_binary(monkeypatch, script: str):
    """Point sigrok_cli at a Python one-off standing in for ``sigrok-cli``."""
    monkeypatch.setattr(sigrok_cli, "_binary", lambda: sys.executable)
    return ["-c", script]


def test_coordinated_run_fires_callback_only_after_sampling_starts(monkeypatch):
    # stderr stays quiet, then emits the acquisition-start marker after a delay;
    # stdout (annotations) follows. on_armed must not fire before the marker.
    script = (
        "import sys, time\n"
        "sys.stderr.write('sr: Starting.\\n'); sys.stderr.flush()\n"
        "time.sleep(0.3)\n"
        "sys.stderr.write('kingst: First receive callback in stream mode.\\n')\n"
        "sys.stderr.flush()\n"
        "time.sleep(0.1)\n"
        "sys.stdout.write('0-40 i2c-1: Start\\n'); sys.stdout.flush()\n"
    )
    args = _fake_binary(monkeypatch, script)

    fired_at: list[float] = []
    start = time.monotonic()

    def on_armed() -> None:
        fired_at.append(time.monotonic() - start)

    stdout, armed_via_marker = sigrok_cli.run_coordinated(
        args, on_armed=on_armed, arm_timeout_s=5.0, timeout_s=10.0
    )

    assert armed_via_marker is True
    assert len(fired_at) == 1
    # The marker only appears ~0.3s in, so a callback earlier than that would
    # mean we resumed before the window was open.
    assert fired_at[0] >= 0.25
    assert "Start" in stdout


def test_coordinated_run_falls_back_to_callback_on_arm_timeout(monkeypatch):
    # No marker is ever emitted; on_armed must still fire exactly once so a
    # coordinator never leaves its target halted, and the flag reports fallback.
    script = (
        "import sys, time\n"
        "sys.stderr.write('sr: no marker here\\n'); sys.stderr.flush()\n"
        "time.sleep(0.4)\n"
        "sys.stdout.write('done\\n'); sys.stdout.flush()\n"
    )
    args = _fake_binary(monkeypatch, script)

    calls: list[int] = []
    stdout, armed_via_marker = sigrok_cli.run_coordinated(
        args, on_armed=lambda: calls.append(1), arm_timeout_s=0.2, timeout_s=10.0
    )

    assert armed_via_marker is False
    assert calls == [1]
    assert "done" in stdout


def test_coordinated_run_raises_on_nonzero_exit(monkeypatch):
    script = (
        "import sys\n"
        "sys.stderr.write('sr: device busy\\n')\n"
        "sys.exit(3)\n"
    )
    args = _fake_binary(monkeypatch, script)

    with pytest.raises(OperationFailedError, match="device busy"):
        sigrok_cli.run_coordinated(
            args, on_armed=lambda: None, arm_timeout_s=0.1, timeout_s=10.0
        )


def test_decode_coordinated_adds_loglevel_and_sample_ranges(monkeypatch):
    captured: dict[str, object] = {}

    def fake_run_coordinated(args, *, on_armed, arm_timeout_s, timeout_s):
        captured["args"] = args
        on_armed()
        return "", True

    monkeypatch.setattr(sigrok_cli, "run_coordinated", fake_run_coordinated)

    armed: list[int] = []
    sigrok_cli.decode_raw_coordinated(
        "kingst-la2016:conn=3.8",
        on_armed=lambda: armed.append(1),
        sample_rate_hz=4_000_000,
        num_samples=400_000,
        protocol="i2c",
        channel_map={"scl": "CH1", "sda": "CH0"},
    )

    args = captured["args"]
    assert args[:2] == ["-l", "5"]
    assert "--protocol-decoder-samplenum" in args
    assert armed == [1]


def test_decode_requests_protocol_annotation_sample_ranges(monkeypatch):
    captured: dict[str, object] = {}

    def fake_run(args, *, timeout_s):
        captured["args"] = args
        captured["timeout_s"] = timeout_s
        return ""

    monkeypatch.setattr(sigrok_cli, "run", fake_run)

    sigrok_cli.decode_raw(
        "kingst-la2016:conn=3.8",
        sample_rate_hz=4_000_000,
        num_samples=400_000,
        protocol="i2c",
        channel_map={"scl": "CH1", "sda": "CH0"},
    )

    args = captured["args"]
    assert "--protocol-decoder-samplenum" in args
    assert args.index("--protocol-decoder-samplenum") < args.index("-A")
