"""Tests for the runtime-checkable capability Protocols."""

from __future__ import annotations

from typing import Any, Callable

from boardex_core import (
    NativeSession,
    OperationResult,
    SupportsHaltModeDebug,
    SupportsPeripheralInspection,
    SupportsRttLocation,
    SupportsSessions,
)
from boardex_core.testing import FakeTargetController


class _BareAdapter:
    """No optional capabilities."""


class _FakeNative:
    def run(self, operation: Callable[[Any], OperationResult]) -> OperationResult:
        return operation(None)

    def open_rtt(self, *, control_block_address: int | None = None) -> Any:
        raise NotImplementedError

    def close(self) -> None:
        pass


class _FullAdapter:
    def probe_unique_id(self, device_id: str) -> str:
        return device_id

    def open_native_session(
        self, device_id: str, *, target: str | None = None
    ) -> _FakeNative:
        return _FakeNative()

    def inspect_peripheral(
        self, device_id: str, peripheral: str, *, target: str | None = None
    ) -> OperationResult:
        return OperationResult.passed("inspected")

    def rtt_control_block(
        self, device_id: str, elf_path: str | None = None
    ) -> int | None:
        return 0x20000000


def test_bare_adapter_supports_nothing() -> None:
    adapter = _BareAdapter()
    assert not isinstance(adapter, SupportsSessions)
    assert not isinstance(adapter, SupportsPeripheralInspection)
    assert not isinstance(adapter, SupportsRttLocation)
    assert not isinstance(adapter, SupportsHaltModeDebug)


def test_fake_target_controller_supports_halt_mode_debug() -> None:
    # The reference fake implements every optional capability, including the
    # Phase 2 halt-mode debug surface.
    assert isinstance(FakeTargetController(), SupportsHaltModeDebug)


def test_full_adapter_supports_all() -> None:
    adapter = _FullAdapter()
    assert isinstance(adapter, SupportsSessions)
    assert isinstance(adapter, SupportsPeripheralInspection)
    assert isinstance(adapter, SupportsRttLocation)


def test_fake_native_session_satisfies_protocol() -> None:
    assert isinstance(_FakeNative(), NativeSession)
