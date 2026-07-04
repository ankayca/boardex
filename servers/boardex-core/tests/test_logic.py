"""Tests for the LogicAnalyzer contract via a fake backend. No hardware.

Mirrors test_registry.py: exercising a whole new capability domain through the
same registry -> resolve -> operate flow proves the layered design generalises
beyond the target server, and lets logic-server agent logic be tested with no
analyzer attached.
"""

from __future__ import annotations

import pytest

from boardex_core import (
    BackendRegistry,
    DeviceInfo,
    LogicAnalyzer,
    OperationResult,
)


class FakeLogicAnalyzer(LogicAnalyzer):
    """In-memory 8-channel analyzer that fabricates a square wave on ch0."""

    backend_name = "fake-logic"

    def scan(self) -> list[DeviceInfo]:
        return [
            DeviceInfo(
                device_id="fake-logic:001",
                kind="logic_analyzer",
                vendor="Boardex",
                model="FakeLA",
                backend=self.backend_name,
            )
        ]

    def capabilities(self, device_id):
        return OperationResult.passed(
            "8ch fake logic analyzer.",
            channels=[f"D{i}" for i in range(8)],
            max_sample_rate_hz=24_000_000,
            streaming=True,
            triggers=["rising", "falling", "high", "low"],
        )

    def capture(
        self,
        device_id,
        *,
        channels=None,
        sample_rate_hz=1_000_000,
        num_samples=None,
        duration_s=None,
        trigger_channel=None,
        trigger_edge="rising",
    ):
        n = num_samples or int((duration_s or 0.001) * sample_rate_hz)
        # A square wave toggling every 2 samples -> transitions at even indices.
        transitions = [[i, i // 2 % 2] for i in range(0, n, 2)]
        return OperationResult.passed(
            f"Captured {n} samples.",
            sample_rate_hz=sample_rate_hz,
            num_samples=n,
            channels=channels or [0],
            transitions={"D0": transitions},
        )


@pytest.fixture()
def registry() -> BackendRegistry[LogicAnalyzer]:
    reg: BackendRegistry[LogicAnalyzer] = BackendRegistry()
    reg.register("fake-logic", FakeLogicAnalyzer)
    return reg


def test_logic_scan_and_resolve(registry):
    devices = registry.scan()
    assert [d.kind for d in devices] == ["logic_analyzer"]
    assert registry.resolve("fake-logic:001").backend_name == "fake-logic"


def test_logic_capabilities(registry):
    caps = registry.resolve("fake-logic:001").capabilities("fake-logic:001")
    assert caps.ok
    assert len(caps.data["channels"]) == 8


def test_logic_capture_returns_transitions(registry):
    la = registry.resolve("fake-logic:001")
    result = la.capture("fake-logic:001", sample_rate_hz=1_000_000, num_samples=10)
    assert result.ok
    assert result.data["num_samples"] == 10
    assert result.data["transitions"]["D0"][0] == [0, 0]
