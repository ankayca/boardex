"""Tests for entry-point based backend plugin discovery."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import pytest

from boardex_core import BackendRegistry, DeviceInfo, LogicAnalyzer, OperationResult
from boardex_core import registry as registry_module


class _Analyzer(LogicAnalyzer):
    backend_name = "plug"

    def __init__(self) -> None:
        self.sessions = None

    def scan(self) -> list[DeviceInfo]:
        return [
            DeviceInfo(
                device_id=f"{self.backend_name}:1",
                kind="logic_analyzer",
                vendor="Acme",
                model="LA",
                backend=self.backend_name,
            )
        ]

    def capabilities(self, device_id: str) -> OperationResult:
        return OperationResult.passed("caps")

    def capture(self, device_id: str, **kwargs: Any) -> OperationResult:
        return OperationResult.passed("captured")


class _ContextAnalyzer(_Analyzer):
    backend_name = "ctx"

    def __init__(self, sessions: Any = None) -> None:
        super().__init__()
        self.sessions = sessions


@dataclass
class _FakeEntryPoint:
    name: str
    value: str
    _load: Callable[[], Any]

    def load(self) -> Any:
        return self._load()


def _patch_entry_points(monkeypatch: pytest.MonkeyPatch, eps: list[_FakeEntryPoint]) -> None:
    monkeypatch.setattr(
        registry_module, "entry_points", lambda *, group: list(eps)
    )


def test_load_plugins_registers_and_scans(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_entry_points(
        monkeypatch, [_FakeEntryPoint("plug", "pkg:cls", lambda: _Analyzer)]
    )
    registry: BackendRegistry[LogicAnalyzer] = BackendRegistry()
    assert registry.load_plugins("some.group") == ["plug"]
    assert registry.registered_backends() == ["plug"]
    assert [d.device_id for d in registry.scan()] == ["plug:1"]


def test_load_plugins_passes_only_declared_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_entry_points(
        monkeypatch,
        [
            _FakeEntryPoint("plug", "pkg:cls", lambda: _Analyzer),
            _FakeEntryPoint("ctx", "pkg:ctx", lambda: _ContextAnalyzer),
        ],
    )
    registry: BackendRegistry[LogicAnalyzer] = BackendRegistry()
    marker = object()
    registry.load_plugins("some.group", context={"sessions": marker})
    # _Analyzer.__init__ takes no kwargs, so context must not be forced on it.
    assert registry.resolve("plug:1").sessions is None
    # _ContextAnalyzer declares `sessions`, so it receives the shared object.
    assert registry.resolve("ctx:1").sessions is marker


def test_broken_plugin_load_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom() -> Any:
        raise ImportError("missing vendor sdk")

    _patch_entry_points(
        monkeypatch,
        [
            _FakeEntryPoint("bad", "pkg:bad", _boom),
            _FakeEntryPoint("plug", "pkg:cls", lambda: _Analyzer),
        ],
    )
    registry: BackendRegistry[LogicAnalyzer] = BackendRegistry()
    assert registry.load_plugins("some.group") == ["plug"]
    assert registry.registered_backends() == ["plug"]


def test_broken_plugin_factory_degrades_gracefully(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Explodes:
        def __init__(self) -> None:
            raise RuntimeError("adapter constructor crashed")

    _patch_entry_points(
        monkeypatch,
        [
            _FakeEntryPoint("boom", "pkg:boom", lambda: _Explodes),
            _FakeEntryPoint("plug", "pkg:cls", lambda: _Analyzer),
        ],
    )
    registry: BackendRegistry[LogicAnalyzer] = BackendRegistry()
    registry.load_plugins("some.group")
    # The broken backend is excluded from health/scan, the good one survives.
    assert registry.available_backends() == ["plug"]
    assert [d.device_id for d in registry.scan()] == ["plug:1"]


def test_duplicate_plugin_name_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_entry_points(
        monkeypatch, [_FakeEntryPoint("plug", "other:cls", lambda: _ContextAnalyzer)]
    )
    registry: BackendRegistry[LogicAnalyzer] = BackendRegistry()
    registry.register("plug", _Analyzer)
    assert registry.load_plugins("some.group") == []
    assert isinstance(registry.resolve("plug:1"), _Analyzer)
