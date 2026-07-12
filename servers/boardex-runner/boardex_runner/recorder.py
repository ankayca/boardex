"""Fixture recorder (BIBLE §10.3).

Tees every emitted event plus inter-event deltas as ``{"delayMs": N, "event":
{...}}`` JSONL — the exact format ``packages/contract/fixtures/*.jsonl`` uses —
and exports every artifact body as ``artifacts/<artifactId>.<ext>`` so the
contract package's fixture test (file-per-artifact, matching sizeBytes) can
run against the recording unmodified.

Deltas are computed from event timestamps, so a virtual-clock (fake bench)
recording carries its narrative pacing regardless of the SPEED it ran at, and
a wall-clock (real bench) recording carries genuine bench timing.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from .artifacts import EXT_BY_KIND, ArtifactStore

# The fixture line schema caps delayMs at 20s (T0.3) so demo pacing never stalls.
MAX_DELAY_MS = 20_000


def _parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


class FixtureRecorder:
    """Records one run's stream to ``<dir>/<name>.jsonl`` (+ artifacts/)."""

    def __init__(self, directory: Path, name: str) -> None:
        self.directory = directory
        self.path = directory / f"{name}.jsonl"
        self.artifacts_dir = directory / "artifacts"
        self._last_ts: datetime | None = None
        directory.mkdir(parents=True, exist_ok=True)
        self.path.write_text("", encoding="utf-8")

    def on_event(self, event: dict[str, Any]) -> None:
        ts = _parse_ts(event["ts"])
        if self._last_ts is None:
            delay_ms = 0
        else:
            delay_ms = int((ts - self._last_ts).total_seconds() * 1000)
        self._last_ts = ts
        delay_ms = min(max(delay_ms, 0), MAX_DELAY_MS)
        line = json.dumps({"delayMs": delay_ms, "event": event}, separators=(",", ":"))
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")

    def export_artifacts(self, store: ArtifactStore, run_id: str) -> list[Path]:
        """Write every artifact the recorded run announced, named ``<id>.<ext>``."""
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        written: list[Path] = []
        for event in _read_events(self.path):
            if event["type"] != "artifact.created":
                continue
            meta = event["payload"]["artifact"]
            stored = store.get(meta["id"])
            if stored is None:
                raise RuntimeError(f"recorded artifact {meta['id']} missing from store")
            ext = EXT_BY_KIND.get(meta["kind"], "bin")
            path = self.artifacts_dir / f"{meta['id']}.{ext}"
            path.write_bytes(stored.content)
            written.append(path)
        return written


def _read_events(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            events.append(json.loads(line)["event"])
    return events
