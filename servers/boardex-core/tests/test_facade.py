"""Tests for the shared MCP-facade helpers."""

from __future__ import annotations

import logging

from boardex_core import (
    BackendRegistry,
    BoardexError,
    DeviceInfo,
    DeviceNotFoundError,
    LogicAnalyzer,
    OperationResult,
    Verdict,
    guard,
    list_devices_result,
)


def test_guard_passes_result_through() -> None:
    result = guard(lambda: OperationResult.passed("ok", value=1))
    assert result.ok
    assert result.data["value"] == 1


def test_guard_converts_boardex_error() -> None:
    def _boom() -> OperationResult:
        raise DeviceNotFoundError("no such device")

    result = guard(_boom)
    assert result.verdict == Verdict.ERROR
    assert "no such device" in result.summary


def test_guard_converts_unexpected_exception() -> None:
    def _boom() -> OperationResult:
        raise RuntimeError("kaboom")

    result = guard(_boom)
    assert result.verdict == Verdict.ERROR
    assert "Unexpected error" in result.summary
    assert "kaboom" in result.summary


def test_guard_uses_provided_logger(caplog) -> None:
    logger = logging.getLogger("boardex.test.facade")

    def _boom() -> OperationResult:
        raise BoardexError("typed failure")

    with caplog.at_level(logging.WARNING, logger="boardex.test.facade"):
        guard(_boom, logger=logger)
    assert any(r.name == "boardex.test.facade" for r in caplog.records)


class _FakeAnalyzer(LogicAnalyzer):
    backend_name = "fake"

    def scan(self) -> list[DeviceInfo]:
        return [
            DeviceInfo(
                device_id="fake:1",
                kind="logic_analyzer",
                vendor="Acme",
                model="LA-1",
                backend="fake",
            )
        ]

    def capabilities(self, device_id: str) -> OperationResult:
        return OperationResult.passed("caps")

    def capture(self, device_id: str, **kwargs) -> OperationResult:
        return OperationResult.passed("captured")


def test_list_devices_result_shape() -> None:
    registry: BackendRegistry[LogicAnalyzer] = BackendRegistry()
    registry.register("fake", _FakeAnalyzer)

    result = list_devices_result(registry, "logic analyzer")
    assert result.ok
    assert result.summary == "Found 1 logic analyzer(s)."
    assert result.data["devices"][0]["device_id"] == "fake:1"
    assert result.data["backends"] == ["fake"]
