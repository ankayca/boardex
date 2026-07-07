"""Run the reference fakes through the conformance suites they must anchor."""

from __future__ import annotations

from boardex_core import (
    NativeSession,
    SupportsPeripheralInspection,
    SupportsRttLocation,
    SupportsSessions,
)
from boardex_core.testing import (
    FakeLogicAnalyzer,
    FakeTargetController,
    LogicAnalyzerConformance,
    TargetControllerConformance,
)


class TestFakeTargetControllerConformance(TargetControllerConformance):
    def make_adapter(self) -> FakeTargetController:
        return FakeTargetController()


class TestFakeLogicAnalyzerConformance(LogicAnalyzerConformance):
    def make_adapter(self) -> FakeLogicAnalyzer:
        return FakeLogicAnalyzer()


def test_fake_target_implements_all_capabilities() -> None:
    fake = FakeTargetController()
    assert isinstance(fake, SupportsSessions)
    assert isinstance(fake, SupportsPeripheralInspection)
    assert isinstance(fake, SupportsRttLocation)
    native = fake.open_native_session("fake-target:0")
    assert isinstance(native, NativeSession)


def test_fake_target_rtt_roundtrip() -> None:
    fake = FakeTargetController()
    native = fake.open_native_session("fake-target:0")
    channel = native.open_rtt()
    fake.emit_rtt("boot ok\n")
    assert channel.read() == b"boot ok\n"
    assert channel.read() == b""


def test_fake_target_memory_roundtrip() -> None:
    fake = FakeTargetController()
    fake.write_memory("fake-target:0", 0x2000_0000, b"\xde\xad")
    result = fake.read_memory("fake-target:0", 0x2000_0000, 2)
    assert result.data["hex"] == "dead"
