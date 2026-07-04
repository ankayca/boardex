"""Tests for the shared core. No hardware required.

These double as a demonstration of *why* the interface/adapter design matters:
we can exercise the full registry -> resolve -> operate flow with a fake backend,
so agent logic can be tested without a bench attached.
"""

from __future__ import annotations

import pytest

from boardex_core import (
    BackendRegistry,
    DeviceInfo,
    DeviceNotFoundError,
    OperationResult,
    TargetController,
    Verdict,
)


class FakeProbe(TargetController):
    """In-memory TargetController used to test the plumbing without hardware."""

    backend_name = "fake"

    def __init__(self) -> None:
        self.memory: dict[int, int] = {}

    def scan(self) -> list[DeviceInfo]:
        return [
            DeviceInfo(
                device_id="fake:001",
                kind="debug_probe",
                vendor="Boardex",
                model="FakeProbe",
                backend=self.backend_name,
            )
        ]

    def flash(self, device_id, firmware_path, *, target=None, verify=True, reset_after=True):
        return OperationResult.passed(f"flashed {firmware_path}", path=firmware_path)

    def reset(self, device_id, *, target=None, halt=False):
        return OperationResult.passed("reset", halted=halt)

    def halt(self, device_id, *, target=None):
        return OperationResult.passed("halted")

    def resume(self, device_id, *, target=None):
        return OperationResult.passed("resumed")

    def read_memory(self, device_id, address, length, *, target=None):
        data = bytes(self.memory.get(address + i, 0) for i in range(length))
        return OperationResult.passed("read", hex=data.hex())

    def write_memory(self, device_id, address, data, *, target=None):
        for i, byte in enumerate(data):
            self.memory[address + i] = byte
        return OperationResult.passed("wrote", length=len(data))

    def read_log(self, device_id, *, target=None, timeout_s=2.0):
        return OperationResult.inconclusive("no log backend")


@pytest.fixture()
def registry() -> BackendRegistry[TargetController]:
    reg: BackendRegistry[TargetController] = BackendRegistry()
    reg.register("fake", FakeProbe)
    return reg


def test_scan_lists_devices(registry):
    devices = registry.scan()
    assert [d.device_id for d in devices] == ["fake:001"]


def test_resolve_returns_owning_backend(registry):
    backend = registry.resolve("fake:001")
    assert backend.backend_name == "fake"


def test_resolve_scans_lazily_for_unknown_id(registry):
    # No explicit scan() first: resolve() should refresh the inventory itself.
    assert registry.resolve("fake:001").backend_name == "fake"


def test_resolve_raises_for_missing_device(registry):
    with pytest.raises(DeviceNotFoundError):
        registry.resolve("nope:999")


def test_write_then_read_roundtrip(registry):
    probe = registry.resolve("fake:001")
    probe.write_memory("fake:001", 0x2000_0000, b"\xde\xad\xbe\xef")
    result = probe.read_memory("fake:001", 0x2000_0000, 4)
    assert result.data["hex"] == "deadbeef"


def test_operation_result_serialisation():
    result = OperationResult.passed("ok", value=1)
    payload = result.to_dict()
    assert payload["verdict"] == "pass"
    assert payload["data"] == {"value": 1}
    assert result.ok is True
    assert Verdict("fail") is Verdict.FAIL
