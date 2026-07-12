"""Fixture recording (§10.3): line format, pacing, artifact export."""

from __future__ import annotations

import json
from pathlib import Path

from boardex_runner.artifacts import ArtifactStore
from boardex_runner.recorder import MAX_DELAY_MS, FixtureRecorder

from conftest import drive_to_terminal, make_engine, run


def record_run(tmp_path: Path, *, fail_variant: bool = False) -> tuple[Path, ArtifactStore]:
    recorder = FixtureRecorder(tmp_path, "recorded_run")
    store = ArtifactStore()
    engine = make_engine(
        fail_variant=fail_variant, on_event=recorder.on_event, artifacts=store
    )
    run(drive_to_terminal(engine))
    recorder.export_artifacts(store, engine.id)
    return recorder.path, store


def test_recorded_lines_follow_the_fixture_format(tmp_path: Path) -> None:
    path, _ = record_run(tmp_path)
    lines = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    assert len(lines) > 50  # the fixture test's plausibility floor
    for i, line in enumerate(lines):
        assert set(line.keys()) == {"delayMs", "event"}
        assert isinstance(line["delayMs"], int)
        assert 0 <= line["delayMs"] <= MAX_DELAY_MS
        assert line["event"]["seq"] == i + 1
    assert lines[0]["event"]["type"] == "run.created"
    assert lines[-1]["event"]["type"] == "run.completed"
    # Virtual-clock pacing survives the recording: the narrative spans minutes
    # of event time even though the run executed in milliseconds.
    assert sum(line["delayMs"] for line in lines) > 30_000


def test_recorded_timestamps_are_monotonic_and_match_deltas(tmp_path: Path) -> None:
    from datetime import datetime

    path, _ = record_run(tmp_path)
    lines = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    prev = None
    for line in lines:
        ts = datetime.fromisoformat(line["event"]["ts"].replace("Z", "+00:00"))
        if prev is not None:
            delta_ms = (ts - prev).total_seconds() * 1000
            assert delta_ms >= 0
            assert abs(delta_ms - line["delayMs"]) < 1.0
        prev = ts


def test_artifact_export_names_and_sizes_match_the_stream(tmp_path: Path) -> None:
    path, store = record_run(tmp_path)
    events = [json.loads(l)["event"] for l in path.read_text().splitlines() if l.strip()]
    artifacts = [e["payload"]["artifact"] for e in events if e["type"] == "artifact.created"]
    assert artifacts
    files = list((tmp_path / "artifacts").iterdir())
    by_stem = {f.name.rsplit(".", 1)[0]: f for f in files}
    for meta in artifacts:
        exported = by_stem[meta["id"]]
        assert exported.stat().st_size == meta["sizeBytes"]
    # Structured artifacts are valid JSON on disk.
    for meta in artifacts:
        if meta["kind"] in ("protocol_decode", "code_diff", "timing_measurement"):
            json.loads(by_stem[meta["id"]].read_text())


def test_fail_variant_recording_ends_in_run_failed(tmp_path: Path) -> None:
    path, _ = record_run(tmp_path, fail_variant=True)
    events = [json.loads(l)["event"] for l in path.read_text().splitlines() if l.strip()]
    assert events[-1]["type"] == "run.failed"
    approval_seqs = [e["seq"] for e in events if e["type"] == "approval.requested"]
    failed_seq = events[-1]["seq"]
    assert all(seq < failed_seq for seq in approval_seqs)
