"""Tests for composite target workflows (no hardware)."""

from __future__ import annotations

import threading
from unittest.mock import MagicMock

import pytest

from boardex_core import BackendRegistry, DeviceInfo, OperationResult, TargetController, Verdict
from boardex_target.session import ManagedSession, SessionManager
from boardex_target import workflows


class FakeTarget(TargetController):
    backend_name = "fake"

    def __init__(self) -> None:
        self.flashed: list[str] = []

    def scan(self) -> list[DeviceInfo]:
        return [
            DeviceInfo(
                device_id="fake:001",
                kind="debug_probe",
                vendor="Boardex",
                model="Fake",
                backend="fake",
            )
        ]

    def flash(self, device_id, firmware_path, **kwargs) -> OperationResult:
        self.flashed.append(firmware_path)
        return OperationResult.passed("flashed", firmware_path=firmware_path)

    def reset(self, device_id, **kwargs) -> OperationResult:
        return OperationResult.passed("reset")

    def halt(self, device_id, **kwargs) -> OperationResult:
        return OperationResult.passed("halt")

    def resume(self, device_id, **kwargs) -> OperationResult:
        return OperationResult.passed("resume")

    def read_memory(self, device_id, address, length, **kwargs) -> OperationResult:
        return OperationResult.passed("read", hex="00")

    def write_memory(self, device_id, address, data, **kwargs) -> OperationResult:
        return OperationResult.passed("write")

    def read_log(self, device_id, **kwargs) -> OperationResult:
        return OperationResult.passed("log", text="")

    def recover(self, device_id, **kwargs) -> OperationResult:
        return OperationResult.passed("recover")

    def get_status(self, device_id, **kwargs) -> OperationResult:
        return OperationResult.passed("status")

    def probe_unique_id(self, device_id: str) -> str:
        return "001"

    def inspect_peripheral(self, device_id, peripheral, **kwargs) -> OperationResult:
        return OperationResult.passed(
            "inspected",
            hints=[f"{peripheral} not muxed"],
            registers={"CR1": {"PE": True}},
        )


@pytest.fixture()
def fake_registry() -> BackendRegistry[TargetController]:
    reg: BackendRegistry[TargetController] = BackendRegistry()
    reg.register("fake", FakeTarget)
    return reg


def test_run_checkpoint_rtt_pass(fake_registry, monkeypatch):
    managed = ManagedSession("sess-1", "fake:001", native=MagicMock(), target=None)
    managed.start_rtt = MagicMock(
        return_value=OperationResult.passed("RTT started", channel="Terminal")
    )
    managed.wait_for_rtt = MagicMock(
        return_value=OperationResult.passed(
            "matched",
            matched=True,
            text="SELF-TEST PASS\n",
            timed_out=False,
        )
    )

    sessions = MagicMock(spec=SessionManager)
    sessions.get.return_value = managed

    result = workflows.run_checkpoint(
        fake_registry,
        sessions,
        workflows.CheckpointSpec(
            device_id="fake:001",
            session_id="sess-1",
            firmware_path="/tmp/test.elf",
            rtt_pattern="SELF-TEST PASS",
            rtt_timeout_s=1.0,
            inspect_on_failure="I2C1",
            elf_path="/tmp/test.elf",
        ),
    )

    assert result.verdict == Verdict.PASS
    assert result.data["evidence"]["rtt"]["matched"] is True
    assert result.data["firmware_path"] == "/tmp/test.elf"


def test_run_checkpoint_rtt_fail_inspects(fake_registry, monkeypatch):
    managed = ManagedSession("sess-1", "fake:001", native=MagicMock(), target=None)
    managed.start_rtt = MagicMock(
        return_value=OperationResult.passed("RTT started", channel="Terminal")
    )
    managed.wait_for_rtt = MagicMock(
        return_value=OperationResult.failed(
            "timeout",
            matched=False,
            text="I2C read failed\n",
            timed_out=True,
        )
    )

    sessions = MagicMock(spec=SessionManager)
    sessions.get.return_value = managed

    result = workflows.run_checkpoint(
        fake_registry,
        sessions,
        workflows.CheckpointSpec(
            device_id="fake:001",
            session_id="sess-1",
            firmware_path="/tmp/test.elf",
            rtt_pattern="SELF-TEST PASS",
            rtt_timeout_s=1.0,
            inspect_on_failure="I2C1",
        ),
    )

    assert result.verdict == Verdict.FAIL
    assert result.data["evidence"]["peripheral"] is not None
    assert "I2C1 not muxed" in result.data["evidence"]["hints"][0]


class _CoordinatedAnalyzer:
    """Analyzer that reports acquisition start via ``on_capture_started``.

    Satisfies ``SupportsCoordinatedCapture`` (has ``decode_coordinated``), so the
    workflow drives the deterministic poll-until-armed path.
    """

    def __init__(self, order: list[str], *, armed: bool = True) -> None:
        self.order = order
        self.armed = armed

    def decode(self, *_args, **_kwargs):  # pragma: no cover - must not be used
        self.order.append("decode_plain")
        raise AssertionError("coordinated analyzer must use decode_coordinated")

    def decode_coordinated(
        self, _device_id, _protocol, _channel_map, *, on_capture_started, **_kwargs
    ):
        self.order.append("decode_entered")
        on_capture_started()
        self.order.append("decode_returned")
        return OperationResult.passed(
            "decoded",
            protocol="i2c",
            sample_rate_hz=4_000_000,
            annotations=[],
            transactions=[],
            armed_via_marker=self.armed,
        )


class _DelayedAnalyzer:
    """Analyzer without coordinated capture; forces the arm-delay fallback."""

    def __init__(self, order: list[str], resumed: threading.Event) -> None:
        self.order = order
        self.resumed = resumed

    def decode(self, *_args, **_kwargs):
        self.order.append("decode_entered")
        assert self.resumed.wait(timeout=1.0)
        self.order.append("decode_returned")
        return OperationResult.passed(
            "decoded",
            protocol="i2c",
            sample_rate_hz=4_000_000,
            annotations=[],
            transactions=[],
        )


def test_reset_and_capture_i2c_resumes_on_acquisition_marker(
    fake_registry, monkeypatch
):
    order: list[str] = []
    target = fake_registry.resolve("fake:001")

    def reset(_device_id, **kwargs):
        order.append("reset_halted")
        assert kwargs["halt"] is True
        return OperationResult.passed("halted at reset")

    def resume(_device_id, **_kwargs):
        order.append("resume")
        return OperationResult.passed("resumed")

    target.reset = reset
    target.resume = resume

    analyzer = _CoordinatedAnalyzer(order)
    monkeypatch.setattr(
        workflows.logic_integration,
        "resolve_logic_analyzer",
        lambda _device_id: analyzer,
    )

    result = workflows.reset_and_capture_i2c(
        fake_registry,
        device_id="fake:001",
        logic_analyzer_id="sigrok:la",
        channel_map={"scl": 1, "sda": 0},
    )

    assert result.ok
    # Resume is gated on the analyzer signalling that sampling is live, and it
    # happens inside the decode call (between entry and return), not after.
    assert order == ["reset_halted", "decode_entered", "resume", "decode_returned"]
    coord = result.data["capture_coordination"]
    assert coord["analyzer_armed_before_resume"] is True
    assert coord["resume_gated_on"] == "acquisition_marker"


def test_reset_and_capture_i2c_marks_arm_delay_when_marker_missed(
    fake_registry, monkeypatch
):
    order: list[str] = []
    target = fake_registry.resolve("fake:001")
    target.reset = MagicMock(return_value=OperationResult.passed("halted"))
    target.resume = MagicMock(return_value=OperationResult.passed("resumed"))

    analyzer = _CoordinatedAnalyzer(order, armed=False)
    monkeypatch.setattr(
        workflows.logic_integration,
        "resolve_logic_analyzer",
        lambda _device_id: analyzer,
    )

    result = workflows.reset_and_capture_i2c(
        fake_registry,
        device_id="fake:001",
        logic_analyzer_id="sigrok:la",
        channel_map={"scl": 1, "sda": 0},
    )

    assert result.data["capture_coordination"]["resume_gated_on"] == "arm_delay"


def test_reset_and_capture_i2c_arm_delay_fallback(fake_registry, monkeypatch):
    order: list[str] = []
    resumed = threading.Event()
    target = fake_registry.resolve("fake:001")

    def reset(_device_id, **kwargs):
        order.append("reset_halted")
        return OperationResult.passed("halted at reset")

    def resume(_device_id, **_kwargs):
        order.append("resume")
        resumed.set()
        return OperationResult.passed("resumed")

    target.reset = reset
    target.resume = resume

    analyzer = _DelayedAnalyzer(order, resumed)
    monkeypatch.setattr(
        workflows.logic_integration,
        "resolve_logic_analyzer",
        lambda _device_id: analyzer,
    )

    result = workflows.reset_and_capture_i2c(
        fake_registry,
        device_id="fake:001",
        logic_analyzer_id="sigrok:la",
        channel_map={"scl": 1, "sda": 0},
        arm_delay_s=0,
    )

    assert result.ok
    assert order == ["reset_halted", "decode_entered", "resume", "decode_returned"]
    assert result.data["capture_coordination"]["resume_gated_on"] == "arm_delay"


def test_reset_and_capture_i2c_resumes_target_when_capture_fails(
    fake_registry, monkeypatch
):
    target = fake_registry.resolve("fake:001")
    target.reset = MagicMock(return_value=OperationResult.passed("halted"))
    target.resume = MagicMock(return_value=OperationResult.passed("resumed"))

    class _BrokenAnalyzer:
        def decode_coordinated(self, *_args, **_kwargs):
            raise RuntimeError("sigrok crashed")

    monkeypatch.setattr(
        workflows.logic_integration,
        "resolve_logic_analyzer",
        lambda _device_id: _BrokenAnalyzer(),
    )

    with pytest.raises(RuntimeError, match="sigrok crashed"):
        workflows.reset_and_capture_i2c(
            fake_registry,
            device_id="fake:001",
            logic_analyzer_id="sigrok:la",
            channel_map={"scl": 1, "sda": 0},
        )

    target.resume.assert_called_once()
