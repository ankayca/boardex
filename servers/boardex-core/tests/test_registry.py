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

    def read_log(self, device_id, *, target=None, timeout_s=2.0, control_block_address=None, elf_path=None):
        return OperationResult.inconclusive("no log backend")

    def recover(self, device_id, *, target=None, mass_erase=True):
        if mass_erase:
            self.memory.clear()
        return OperationResult.passed("recovered", mass_erased=mass_erase)

    def get_status(self, device_id, *, target=None, elf_path=None, halt=False):
        return OperationResult.passed("halted", running=False, faulted=False)


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


class _VolatileProbe(FakeProbe):
    """Scans a device whose id carries a re-enumeration-volatile suffix."""

    backend_name = "vol"

    def __init__(self, device_ids: list[str]) -> None:
        super().__init__()
        self._device_ids = device_ids

    def scan(self) -> list[DeviceInfo]:
        return [
            DeviceInfo(
                device_id=did,
                kind="logic_analyzer",
                vendor="Boardex",
                model="VolatileProbe",
                backend=self.backend_name,
            )
            for did in self._device_ids
        ]


def test_resolve_matches_connection_agnostic_id():
    """A stable id resolves to the sole device with a volatile conn suffix."""
    reg: BackendRegistry[TargetController] = BackendRegistry()
    reg.register("vol", lambda: _VolatileProbe(["vol:fx2lafw:conn=3.8"]))
    assert reg.resolve("vol:fx2lafw").backend_name == "vol"


def test_resolve_ambiguous_shorthand_raises():
    """A shorthand that matches multiple attached devices must fail loudly."""
    reg: BackendRegistry[TargetController] = BackendRegistry()
    reg.register(
        "vol",
        lambda: _VolatileProbe(["vol:fx2lafw:conn=3.8", "vol:fx2lafw:conn=4.2"]),
    )
    with pytest.raises(DeviceNotFoundError, match="Ambiguous"):
        reg.resolve("vol:fx2lafw")


def test_resolve_prefers_exact_over_prefix():
    """An exact id still wins even when it is a prefix of another device."""
    reg: BackendRegistry[TargetController] = BackendRegistry()
    reg.register(
        "vol",
        lambda: _VolatileProbe(["vol:demo", "vol:demo:conn=1.1"]),
    )
    # Exact match must not trip the ambiguity guard for the longer sibling.
    assert reg.resolve("vol:demo").backend_name == "vol"


def test_write_then_read_roundtrip(registry):
    probe = registry.resolve("fake:001")
    probe.write_memory("fake:001", 0x2000_0000, b"\xde\xad\xbe\xef")
    result = probe.read_memory("fake:001", 0x2000_0000, 4)
    assert result.data["hex"] == "deadbeef"


def test_recover_mass_erase_clears_state(registry):
    probe = registry.resolve("fake:001")
    probe.write_memory("fake:001", 0x2000_0000, b"\xde\xad")
    result = probe.recover("fake:001", mass_erase=True)
    assert result.ok
    assert result.data["mass_erased"] is True
    # Every TargetController inherits recover/get_status from the ABC.
    assert probe.read_memory("fake:001", 0x2000_0000, 2).data["hex"] == "0000"


def test_get_status_returns_result(registry):
    result = registry.resolve("fake:001").get_status("fake:001")
    assert result.ok
    assert result.data["faulted"] is False


def test_operation_result_serialisation():
    result = OperationResult.passed("ok", value=1)
    payload = result.to_dict()
    assert payload["verdict"] == "pass"
    assert payload["data"] == {"value": 1}
    assert result.ok is True
    assert Verdict("fail") is Verdict.FAIL
