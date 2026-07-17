"""Turn a raw capture into agent-actionable per-channel measurements.

Pure functions over the transition lists produced by ``parse.parse_csv`` — no
sigrok, no hardware — so they are reusable by every logic-analyzer backend and
fully unit-testable. This is what lets an agent branch on *numbers* ("is the
clock 1 MHz? is the pin idle? is there a glitch?") instead of doing arithmetic
on a raw edge array itself.

A ``transitions`` value is ``{channel_name: [[sample_index, level], ...]}`` where
the first entry is the level at sample 0 and each later entry is an edge.
"""

from __future__ import annotations

from statistics import median

#: Cap on edges returned per channel over the wire. Measurements are computed on
#: the full data first, so truncating the transition list never affects the
#: reported counts/frequencies — it only keeps the JSON payload bounded.
MAX_EDGES_PER_CHANNEL = 2048


def limit_samples(parsed: dict, n: int | None) -> dict:
    """Clamp a parsed capture to the first ``n`` samples.

    Streaming analyzers (e.g. the memory-less Kingst LA1010) over-deliver: a
    request for 1000 samples can return hundreds of thousands. Clamping to the
    requested window makes timing deterministic — a sample index maps to the
    time the agent actually asked for.
    """
    if n is None or parsed["num_samples"] <= n:
        return parsed
    transitions = {
        name: [edge for edge in edges if edge[0] < n]
        for name, edges in parsed["transitions"].items()
    }
    return {
        "channels": parsed["channels"],
        "num_samples": n,
        "transitions": transitions,
    }


def channel_stats(
    edges: list[list[int]], num_samples: int, sample_rate_hz: int
) -> dict:
    """Summarise one channel's activity into a compact, comparable record.

    Returns ``active`` (did it toggle?), ``edges`` (transition count),
    ``frequency_hz`` (fundamental, estimated from rising-edge spacing; ``None``
    if fewer than two rising edges), ``duty_cycle`` (fraction high, 0..1), and
    ``min_pulse_width_s`` (shortest level segment — surfaces glitches/runts).
    """
    edge_count = max(0, len(edges) - 1)
    stats: dict = {
        "active": edge_count > 0,
        "edges": edge_count,
        "frequency_hz": None,
        "duty_cycle": None,
        "min_pulse_width_s": None,
    }
    if not edges or num_samples <= 0:
        return stats

    # Duty cycle: integrate time spent high across segments (last runs to end).
    high_samples = 0
    widths: list[int] = []
    for i, (idx, level) in enumerate(edges):
        end = edges[i + 1][0] if i + 1 < len(edges) else num_samples
        span = end - idx
        if span > 0:
            widths.append(span)
        if level:
            high_samples += span
    stats["duty_cycle"] = round(high_samples / num_samples, 4)

    if sample_rate_hz > 0 and widths:
        stats["min_pulse_width_s"] = min(widths) / sample_rate_hz

    # Fundamental frequency from the spacing between rising edges (0 -> 1).
    rising = [idx for idx, level in edges[1:] if level == 1]
    if sample_rate_hz > 0 and len(rising) >= 2:
        periods = [b - a for a, b in zip(rising, rising[1:])]
        mean_period = sum(periods) / len(periods)
        if mean_period > 0:
            stats["frequency_hz"] = round(sample_rate_hz / mean_period, 2)
    return stats


def summarize(
    transitions: dict[str, list[list[int]]], num_samples: int, sample_rate_hz: int
) -> dict[str, dict]:
    """Per-channel :func:`channel_stats` for every channel in the capture."""
    return {
        name: channel_stats(edges, num_samples, sample_rate_hz)
        for name, edges in transitions.items()
    }


def estimate_i2c_scl_hz(annotations: list[dict], sample_rate_hz: int) -> float | None:
    """Estimate SCL from sigrok's sample-ranged I2C bit annotations.

    The I2C decoder emits one ``0``/``1`` annotation per clocked bit. Its sample
    span is one SCL period; using the median rejects occasional partial boundary
    annotations without treating wider START/ADDRESS/DATA annotations as bits.
    """
    if sample_rate_hz <= 0:
        return None
    spans = [
        annotation["end"] - annotation["start"]
        for annotation in annotations
        if str(annotation.get("text", "")).strip() in {"0", "1"}
        and isinstance(annotation.get("start"), int)
        and isinstance(annotation.get("end"), int)
        and annotation["end"] > annotation["start"]
    ]
    if not spans:
        return None
    return round(sample_rate_hz / median(spans), 2)


def bound_transitions(
    transitions: dict[str, list[list[int]]], limit: int = MAX_EDGES_PER_CHANNEL
) -> tuple[dict[str, list[list[int]]], bool]:
    """Cap each channel's edge list to ``limit`` entries for transport.

    Returns the (possibly clipped) transitions and whether anything was clipped,
    so the caller can warn. Full counts remain available in the measurements.
    """
    truncated = False
    out: dict[str, list[list[int]]] = {}
    for name, edges in transitions.items():
        if len(edges) > limit:
            out[name] = edges[:limit]
            truncated = True
        else:
            out[name] = edges
    return out, truncated
