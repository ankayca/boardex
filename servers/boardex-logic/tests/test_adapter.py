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
        DEVICE,
        "i2c",
        {"scl": 0, "sda": 1},
        sample_rate_hz=4_000_000,
        num_samples=4000,
    )
    assert result.ok
    assert result.data["device_id"] == DEVICE
    assert result.data["channel_map"] == {"scl": 0, "sda": 1}
    assert result.data["sample_rate_hz"] == 4_000_000
    assert result.data["num_samples"] == 4000
    assert result.data["duration_s"] == 0.001
    assert result.data["annotations"][0]["decoder"] == "i2c"
    assert result.data["bus_state"] == "decoded_ok"
    assert result.data["transactions"][0]["addr_7bit"] == 0x24
    # Indices are resolved to the device's channel names before hitting sigrok.
    assert fake_cli["decode"]["channel_map"] == {"scl": "D0", "sda": "D1"}
    assert fake_cli["decode"]["options"]["address_format"] == "unshifted"


def test_decode_reports_physically_measured_i2c_clock(registry, monkeypatch):
    text = (
        "0-40 i2c-1: Start\n"
        "40-80 i2c-1: 0\n"
        "80-120 i2c-1: 1\n"
        "120-160 i2c-1: 0\n"
        "40-160 i2c-1: Address write: EE\n"
        "160-200 i2c-1: Stop\n"
    )
    monkeypatch.setattr(
        "boardex_logic.adapters.sigrok_adapter.sigrok_cli.decode_raw",
        lambda *a, **k: text,
    )
    result = registry.resolve(DEVICE).decode(
        DEVICE,
        "i2c",
        {"scl": 0, "sda": 1},
        sample_rate_hz=4_000_000,
        num_samples=200,
    )
    assert result.data["scl_frequency_hz"] == 100_000.0
    assert result.data["transactions"][0]["addr_7bit"] == 0x77


def test_decode_structured_transactions(registry, monkeypatch):
    la = registry.resolve(DEVICE)
    text = (
        "0-100 i2c: START\n"
        "100-200 i2c: ADDRESS WRITE: EE\n"
        "200-300 i2c: DATA WRITE: D0\n"
        "300-400 i2c: ACK\n"
        "400-500 i2c: START REPEAT\n"
        "500-600 i2c: ADDRESS READ: EF\n"
        "600-700 i2c: DATA READ: 55\n"
        "700-800 i2c: NACK\n"
        "800-900 i2c: STOP\n"
    )
    monkeypatch.setattr(
        "boardex_logic.adapters.sigrok_adapter.sigrok_cli.decode_raw",
        lambda *a, **k: text,
    )
    result = la.decode(DEVICE, "i2c", {"scl": 0, "sda": 1}, num_samples=1000)
    assert result.ok
    assert result.data["bus_state"] == "decoded_ok"
    assert len(result.data["transactions"]) == 2
    assert result.data["transactions"][1]["read"] == [0x55]


def test_decode_with_trigger(registry, monkeypatch):
    captured: dict = {}

    def fake_decode_raw(spec, **kwargs):
        captured.update(kwargs)
        return "0-100 i2c: START\n100-200 i2c: ADDRESS WRITE: EE\n"

    monkeypatch.setattr(
        "boardex_logic.adapters.sigrok_adapter.sigrok_cli.decode_raw",
        fake_decode_raw,
    )
    registry.resolve(DEVICE).decode(
        DEVICE,
        "i2c",
        {"scl": 1, "sda": 0},
        num_samples=500,
        trigger_channel=1,
        trigger_edge="falling",
    )
    assert captured["trigger"] == ("D1", "f")
    assert "D0" in captured["channels"] and "D1" in captured["channels"]


def test_adapter_advertises_coordinated_capture(registry):
    from boardex_core import SupportsCoordinatedCapture

    assert isinstance(registry.resolve(DEVICE), SupportsCoordinatedCapture)


def test_decode_coordinated_invokes_callback_and_flags_arm(registry, monkeypatch):
    captured: dict = {}

    def fake_decode_raw_coordinated(spec, *, on_armed, **kwargs):
        captured.update(kwargs)
        on_armed()
        return "0-100 i2c: START\n100-200 i2c: ADDRESS WRITE: EE\n", True

    monkeypatch.setattr(
        "boardex_logic.adapters.sigrok_adapter.sigrok_cli.decode_raw_coordinated",
        fake_decode_raw_coordinated,
    )

    fired: list[int] = []
    result = registry.resolve(DEVICE).decode_coordinated(
        DEVICE,
        "i2c",
        {"scl": 0, "sda": 1},
        on_capture_started=lambda: fired.append(1),
        sample_rate_hz=4_000_000,
        num_samples=400,
    )

    assert fired == [1]
    assert result.ok
    assert result.data["armed_via_marker"] is True
    assert result.data["transactions"][0]["addr_7bit"] == 0x77
    # I2C address mode still forced unshifted on the coordinated path.
    assert captured["options"]["address_format"] == "unshifted"


def test_decode_coordinated_warns_when_marker_missed(registry, monkeypatch):
    def fake_decode_raw_coordinated(spec, *, on_armed, **kwargs):
        on_armed()
        return "", False

    monkeypatch.setattr(
        "boardex_logic.adapters.sigrok_adapter.sigrok_cli.decode_raw_coordinated",
        fake_decode_raw_coordinated,
    )

    result = registry.resolve(DEVICE).decode_coordinated(
        DEVICE,
        "i2c",
        {"scl": 0, "sda": 1},
        on_capture_started=lambda: None,
        num_samples=400,
    )

    assert result.data["armed_via_marker"] is False
    assert any("fallback" in w for w in result.warnings)


def test_unavailable_backend_scans_empty(monkeypatch):
    monkeypatch.setattr(sigrok_cli, "sigrok_available", lambda: False)
    reg: BackendRegistry[LogicAnalyzer] = BackendRegistry()
    reg.register("sigrok", SigrokAdapter)
    assert reg.scan() == []
