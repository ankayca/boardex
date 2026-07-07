"""Tests for composite target workflows (no hardware)."""

from __future__ import annotations

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
