"""Unit tests for capture analysis (measurements). No hardware, pure functions."""

from __future__ import annotations

from boardex_logic import analyze


def test_idle_channel():
    # One entry = level at sample 0, never changed.
    s = analyze.channel_stats([[0, 0]], num_samples=1000, sample_rate_hz=1_000_000)
    assert s["active"] is False
    assert s["edges"] == 0
    assert s["frequency_hz"] is None
    assert s["duty_cycle"] == 0.0


def test_square_wave_frequency_and_duty():
    # 1 MHz sampling; toggles every 5 samples -> 100 kHz, 50% duty.
    edges = [[0, 0]]
    level = 0
    for i in range(5, 100, 5):
        level ^= 1
        edges.append([i, level])
    s = analyze.channel_stats(edges, num_samples=100, sample_rate_hz=1_000_000)
    assert s["active"] is True
    assert s["frequency_hz"] == 100_000.0
    assert 0.45 <= s["duty_cycle"] <= 0.55
    assert s["min_pulse_width_s"] == 5 / 1_000_000


def test_glitch_shows_small_min_pulse_width():
    # A 1-sample runt among wide pulses.
    edges = [[0, 0], [100, 1], [101, 0], [200, 1], [300, 0]]
    s = analyze.channel_stats(edges, num_samples=400, sample_rate_hz=10_000_000)
    assert s["min_pulse_width_s"] == 1 / 10_000_000


def test_summarize_multiple_channels():
    transitions = {"CH0": [[0, 0], [2, 1]], "CH1": [[0, 1]]}
    m = analyze.summarize(transitions, num_samples=4, sample_rate_hz=1_000_000)
    assert m["CH0"]["active"] is True
    assert m["CH1"]["active"] is False
    assert m["CH1"]["duty_cycle"] == 1.0


def test_estimate_i2c_scl_from_sample_ranged_bit_annotations():
    annotations = [
        {"start": 0, "end": 40, "text": "Start"},
        {"start": 40, "end": 80, "text": "0"},
        {"start": 80, "end": 120, "text": "1"},
        {"start": 120, "end": 161, "text": "0"},
        {"start": 40, "end": 161, "text": "Address write: EE"},
    ]
    assert analyze.estimate_i2c_scl_hz(annotations, 4_000_000) == 100_000.0


def test_estimate_i2c_scl_requires_measured_bit_spans():
    assert analyze.estimate_i2c_scl_hz([{"text": "0"}], 4_000_000) is None


def test_limit_samples_clamps_window():
    parsed = {
        "channels": ["CH0"],
        "num_samples": 1000,
        "transitions": {"CH0": [[0, 0], [10, 1], [500, 0], [900, 1]]},
    }
    out = analyze.limit_samples(parsed, 100)
    assert out["num_samples"] == 100
    assert out["transitions"]["CH0"] == [[0, 0], [10, 1]]


def test_limit_samples_noop_when_within_window():
    parsed = {"channels": ["CH0"], "num_samples": 50, "transitions": {"CH0": [[0, 0]]}}
    assert analyze.limit_samples(parsed, 100) is parsed


def test_bound_transitions_caps_and_flags():
    big = {"CH0": [[i, i % 2] for i in range(5000)]}
    out, truncated = analyze.bound_transitions(big, limit=100)
    assert truncated is True
    assert len(out["CH0"]) == 100
    small, truncated2 = analyze.bound_transitions({"CH0": [[0, 0]]}, limit=100)
    assert truncated2 is False
