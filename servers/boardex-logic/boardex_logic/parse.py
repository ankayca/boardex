"""Pure parsers turning ``sigrok-cli`` text output into structured data.

No subprocess, no hardware, no sigrok import: everything here is a pure function
over strings, so the fiddly output-format handling is fully unit-testable. The
adapter feeds raw stdout in and gets agent-friendly dicts out.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# sigrok's single-char trigger codes -> Boardex's brand-neutral edge names.
_TRIGGER_CODE_TO_EDGE: dict[str, str] = {
    "0": "low",
    "1": "high",
    "r": "rising",
    "f": "falling",
    "e": "either",
}

_SI = {"": 1, "k": 1_000, "m": 1_000_000, "g": 1_000_000_000}
# A samplerate token such as "100 MHz", "20kHz", "1.5 GHz".
_RATE_RE = re.compile(r"(\d+(?:\.\d+)?)\s*([kMG])?Hz", re.IGNORECASE)


@dataclass
class ScannedDevice:
    """One device parsed from ``sigrok-cli --scan``.

    ``spec`` is the string to hand back to ``sigrok-cli -d`` (driver + conn), and
    is what a Boardex ``device_id`` wraps.
    """

    spec: str
    driver: str
    conn: str | None
    model: str
    channels: list[str] = field(default_factory=list)


def parse_rate(text: str) -> int | None:
    """Parse a single samplerate token (e.g. ``"100 MHz"``) into Hz."""
    m = _RATE_RE.search(text)
    if not m:
        return None
    value, unit = m.groups()
    return int(float(value) * _SI[(unit or "").lower()])


def _split_device_line(line: str) -> ScannedDevice | None:
    """Parse a ``<spec> - <model> with N channels: D0 D1 ...`` device line."""
    if " - " not in line:
        return None
    spec, rest = line.split(" - ", 1)
    spec = spec.strip()
    if not spec or spec.endswith(":") or " " in spec.split(":")[0]:
        return None  # not a device spec line (prose, headers, ...)
    driver = spec.split(":", 1)[0]
    conn_match = re.search(r"conn=([^\s:]+)", spec)
    conn = conn_match.group(1) if conn_match else None

    model = rest.strip()
    channels: list[str] = []
    if " with " in rest and "channel" in rest:
        model = rest.split(" with ", 1)[0].strip()
    if "channels:" in rest:
        channels = rest.split("channels:", 1)[1].split()
    return ScannedDevice(
        spec=spec, driver=driver, conn=conn, model=model, channels=channels
    )


def parse_scan(text: str) -> list[ScannedDevice]:
    """Parse ``sigrok-cli --scan`` output into a list of devices."""
    devices: list[ScannedDevice] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.lower().startswith("the following devices"):
            continue
        dev = _split_device_line(line)
        if dev is not None:
            devices.append(dev)
    return devices


def parse_show(text: str) -> dict:
    """Parse ``sigrok-cli -d <spec> --show`` into capabilities.

    Returns ``channels``, ``samplerates`` (sorted Hz), ``max_sample_rate_hz`` and
    the supported ``triggers`` (brand-neutral edge names). Best-effort and
    tolerant of formatting differences across sigrok versions.
    """
    channels: list[str] = []
    for line in text.splitlines():
        dev = _split_device_line(line.strip())
        if dev is not None and dev.channels:
            channels = dev.channels
            break

    rates = sorted({parse_rate(m.group(0)) or 0 for m in _RATE_RE.finditer(text)})
    rates = [r for r in rates if r > 0]

    triggers: list[str] = []
    tm = re.search(r"[Tt]rigger matches:\s*(.+)", text)
    if tm:
        for code in tm.group(1).split():
            edge = _TRIGGER_CODE_TO_EDGE.get(code)
            if edge and edge not in triggers:
                triggers.append(edge)

    return {
        "channels": channels,
        "samplerates": rates,
        "max_sample_rate_hz": rates[-1] if rates else None,
        "triggers": triggers,
    }


def _is_number(token: str) -> bool:
    try:
        float(token)
        return True
    except ValueError:
        return False


def parse_csv(text: str) -> dict:
    """Parse ``sigrok-cli -O csv`` output into compact per-channel transitions.

    A full acquisition can be millions of samples; the agent almost never wants a
    raw bit dump. So we collapse each channel to an edge list: ``[[sample_index,
    level], ...]`` starting with the level at sample 0 and recording only where it
    changes. Returns ``channels``, ``num_samples`` and ``transitions``.
    """
    header: list[str] | None = None
    comment_names: list[str] | None = None
    rows: list[list[int]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith((";", "#")):
            # libsigrok emits "; Channels (2/13): D0, D1" — the authoritative
            # channel names, more reliable than the (version-dependent) header.
            m = re.search(r"[Cc]hannels\s*\([^)]*\):\s*(.+)", line)
            if m:
                comment_names = [c.strip() for c in m.group(1).split(",") if c.strip()]
            continue
        if not line or line.startswith("FRAME-"):
            # libsigrok emits FRAME-BEGIN/FRAME-END markers between frames.
            continue
        fields = [f.strip() for f in line.split(",") if f.strip() != ""]
        if not fields:
            continue
        if header is None and not all(_is_number(f) for f in fields):
            header = fields
            continue
        if all(_is_number(f) for f in fields):
            rows.append([int(float(f)) for f in fields])

    if not rows:
        return {"channels": header or [], "num_samples": 0, "transitions": {}}

    width = len(rows[0])
    # Drop a leading time/sample column if the header labels one.
    drop_first = header is not None and header[0].lower() in ("time", "sample", "t")
    start_col = 1 if drop_first and width > 1 else 0
    n_data = width - start_col

    # Prefer the "; Channels" comment names; fall back to a real header, then to
    # synthetic Dn (also used when the header is generic like "logic,logic").
    if comment_names is not None and len(comment_names) == n_data:
        names = comment_names
    elif (
        header is not None
        and len(header) == width
        and len(set(header[start_col:])) == n_data
    ):
        names = header[start_col:]
    else:
        names = [f"D{i}" for i in range(n_data)]

    transitions: dict[str, list[list[int]]] = {name: [] for name in names}
    prev: list[int | None] = [None] * len(names)
    for sample_index, row in enumerate(rows):
        for col, name in enumerate(names):
            level = row[start_col + col]
            if prev[col] != level:
                transitions[name].append([sample_index, level])
                prev[col] = level

    return {
        "channels": names,
        "num_samples": len(rows),
        "transitions": transitions,
    }


def parse_annotations(text: str) -> list[dict]:
    """Parse ``sigrok-cli -A`` protocol-decoder annotation lines.

    Each line looks like ``<start>-<end> <decoder>: <text>`` (sample ranges) or
    just ``<decoder>: <text>``. We keep it loose and return one dict per line
    with whatever we could pull out, plus the raw line.
    """
    out: list[dict] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        entry: dict = {"raw": line}
        m = re.match(r"^(\d+)-(\d+)\s+(.*)$", line)
        if m:
            entry["start"] = int(m.group(1))
            entry["end"] = int(m.group(2))
            line = m.group(3)
        if ":" in line:
            decoder, _, message = line.partition(":")
            entry["decoder"] = decoder.strip()
            entry["text"] = message.strip()
        else:
            entry["text"] = line
        out.append(entry)
    return out
