"""Tests for SigrokAdapter with the sigrok-cli binary stubbed out.

Proves the adapter maps sigrok text output onto the LogicAnalyzer contract and
flows through the registry (scan -> resolve -> operate) exactly like the target
server, with no binary installed and no analyzer attached.
"""

from __future__ import annotations

import pytest

from boardex_core import BackendRegistry, LogicAnalyzer
from boardex_logic import sigrok_cli
from boardex_logic.adapters.sigrok_adapter import SigrokAdapter

SCAN = (
    "kingst-la2016:conn=3.7 - Kingst LA2016 with 16 channels: "
    "D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13 D14 D15\n"
    "fx2lafw:conn=1.24 - Saleae Logic with 8 channels: "
    "D0 D1 D2 D3 D4 D5 D6 D7\n"
)

SHOW = """\
kingst-la2016:conn=3.7 - Kingst LA2016 with 16 channels: D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13 D14 D15
Supported configuration options:
    Trigger matches: 0 1 r f
    Sample rate - supported samplerates:
      20 kHz
      1 MHz
      100 MHz
      200 MHz
"""

CSV = "D0,D1,D2\n0,1,0\n0,1,0\n1,1,0\n1,0,0\n"


@pytest.fixture()
def fake_cli(monkeypatch):
    """Stub every sigrok_cli subprocess call with canned output."""
    calls: dict[str, list] = {}
    monkeypatch.setattr(sigrok_cli, "sigrok_available", lambda: True)
    monkeypatch.setattr(sigrok_cli, "scan_raw", lambda: SCAN)
    monkeypatch.setattr(sigrok_cli, "show_raw", lambda spec: SHOW)

    def fake_capture_csv(spec, **kwargs):
        calls["capture"] = kwargs
        return CSV

    def fake_decode_raw(spec, **kwargs):
        calls["decode"] = kwargs
        return "0-1200 i2c: START\n1200-4000 i2c: ADDRESS WRITE: 48\n"

    monkeypatch.setattr(sigrok_cli, "capture_csv", fake_capture_csv)
    monkeypatch.setattr(sigrok_cli, "decode_raw", fake_decode_raw)
    return calls


@pytest.fixture()
def registry(fake_cli) -> BackendRegistry[LogicAnalyzer]:
    reg: BackendRegistry[LogicAnalyzer] = BackendRegistry()
    reg.register("sigrok", SigrokAdapter)
    return reg


DEVICE = "sigrok:kingst-la2016:conn=3.7"


def test_scan_and_resolve(registry):
    devices = registry.scan()
    assert {d.kind for d in devices} == {"logic_analyzer"}
    ids = [d.device_id for d in devices]
    assert DEVICE in ids
    assert registry.resolve(DEVICE).backend_name == "sigrok"


def test_scan_device_fields(registry):
    kingst = next(d for d in registry.scan() if d.device_id == DEVICE)
    assert kingst.vendor == "Kingst"
    assert kingst.model == "LA2016"
    assert kingst.extra["driver"] == "kingst-la2016"
    assert kingst.extra["conn"] == "3.7"


def test_capabilities(registry):
    caps = registry.resolve(DEVICE).capabilities(DEVICE)
    assert caps.ok
    assert caps.data["channel_count"] == 16
    assert caps.data["max_sample_rate_hz"] == 200_000_000


def test_capture_builds_request_and_parses(registry, fake_cli):
    la = registry.resolve(DEVICE)
    result = la.capture(
        DEVICE,
        channels=[0, 1, 2],
        sample_rate_hz=1_000_000,
        num_samples=4,
        trigger_channel=1,
        trigger_edge="falling",
    )
    assert result.ok
    assert result.data["num_samples"] == 4
    assert result.data["transitions"]["D0"] == [[0, 0], [2, 1]]
    # Agent-actionable measurements accompany the raw transitions.
    assert result.data["measurements"]["D0"]["active"] is True
    assert result.data["measurements"]["D2"]["active"] is False
    assert result.data["duration_s"] == 4 / 1_000_000
    # The adapter translated Boardex args into sigrok-cli arguments.
    assert fake_cli["capture"]["channels"] == ["D0", "D1", "D2"]
    assert fake_cli["capture"]["trigger"] == ("D1", "f")


def test_capture_requires_length(registry):
    result = registry.resolve(DEVICE).capture(DEVICE, sample_rate_hz=1_000_000)
    assert result.verdict.value == "error"


def test_capture_duration_converts_to_samples(registry, fake_cli):
    registry.resolve(DEVICE).capture(DEVICE, sample_rate_hz=1_000_000, duration_s=0.001)
    assert fake_cli["capture"]["num_samples"] == 1000


def test_bad_trigger_edge_errors(registry):
    result = registry.resolve(DEVICE).capture(
        DEVICE, num_samples=4, trigger_channel=0, trigger_edge="sideways"
    )
    assert result.verdict.value == "error"


def test_decode(registry, fake_cli):
    result = registry.resolve(DEVICE).decode(
        DEVICE, "i2c", {"scl": 0, "sda": 1}, num_samples=4000
    )
    assert result.ok
    assert result.data["annotations"][0]["decoder"] == "i2c"
    # Indices are resolved to the device's channel names before hitting sigrok.
    assert fake_cli["decode"]["channel_map"] == {"scl": "D0", "sda": "D1"}


def test_unavailable_backend_scans_empty(monkeypatch):
    monkeypatch.setattr(sigrok_cli, "sigrok_available", lambda: False)
    reg: BackendRegistry[LogicAnalyzer] = BackendRegistry()
    reg.register("sigrok", SigrokAdapter)
    assert reg.scan() == []
