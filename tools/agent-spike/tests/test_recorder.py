"""Fixture-format validity of a synthetic short run: every line is
{delayMs, event}, delayMs in [0, 20000], events contract-valid, seq gapless
from 1, ts monotonic, run.created first, exactly one terminal event last."""

from __future__ import annotations

import json

import pytest

from agent_spike.contract import ContractViolation, validate_event
from agent_spike.recorder import RunRecorder, iso_now

from conftest import REPO_ROOT, read_events


def make_run(rec: RunRecorder) -> None:
    rec.run_created(
        {
            "id": rec.run_id,
            "title": "Synthetic",
            "taskPrompt": "synthetic short run",
            "boardProfileId": "bp_test",
            "status": "planning",
            "createdAt": iso_now(),
            "updatedAt": iso_now(),
            "iteration": 1,
        }
    )
    rec.status_changed("plan_ready", "Plan ready for review")
    rec.emit(
        "run.plan_generated",
        {
            "plan": [
                {"index": 0, "title": "t", "detail": "d", "riskLevel": "low", "hardwareAction": False}
            ],
            "riskSummary": "none",
        },
    )
    rec.status_changed("running", "Plan approved")
    step_id = rec.next_step_id("build")
    rec.emit(
        "step.started",
        {
            "step": {
                "id": step_id,
                "runId": rec.run_id,
                "planIndex": 0,
                "kind": "build",
                "status": "active",
                "title": "Build",
                "startedAt": iso_now(),
                "artifactIds": [],
            }
        },
    )
    rec.emit("step.log", {"stepId": step_id, "stream": "build", "lines": ["$ make", "ok"]})
    art = rec.add_artifact(kind="build_log", label="Build log", step_id=step_id, content=b"ok\n")
    rec.emit("step.completed", {"stepId": step_id, "summary": "Built.", "artifactIds": [art]})
    rec.emit("run.completed", {"summary": "done", "reportArtifactId": art})


def test_synthetic_run_is_fixture_valid(tmp_path):
    rec = RunRecorder(tmp_path / "rec", "run_test_001", REPO_ROOT)
    make_run(rec)
    rec.close()

    lines = read_events(tmp_path / "rec")
    assert len(lines) == 9
    prev_ts = None
    for i, line in enumerate(lines):
        assert set(line) == {"delayMs", "event"}
        assert isinstance(line["delayMs"], int) and 0 <= line["delayMs"] <= 20000
        event = line["event"]
        validate_event(REPO_ROOT, event)  # raises on any contract violation
        assert event["seq"] == i + 1  # gapless from 1
        if prev_ts is not None:
            assert event["ts"] >= prev_ts  # ISO-8601 Z strings sort chronologically
        prev_ts = event["ts"]
    assert lines[0]["event"]["type"] == "run.created"
    assert lines[-1]["event"]["type"] == "run.completed"

    # artifact bytes land under artifacts/<id><ext> with honest sizeBytes
    artifact = next(
        line["event"]["payload"]["artifact"]
        for line in lines
        if line["event"]["type"] == "artifact.created"
    )
    path = tmp_path / "rec" / "artifacts" / f"{artifact['id']}.log"
    assert path.is_file() and path.stat().st_size == artifact["sizeBytes"]


def test_recorder_seals_after_terminal(tmp_path):
    rec = RunRecorder(tmp_path / "rec", "run_test_002", REPO_ROOT)
    make_run(rec)
    with pytest.raises(ContractViolation, match="sealed"):
        rec.emit("run.status_changed", {"status": "running"})


def test_recorder_requires_terminal_on_close(tmp_path):
    rec = RunRecorder(tmp_path / "rec", "run_test_003", REPO_ROOT)
    rec.run_created(
        {
            "id": rec.run_id,
            "title": "t",
            "taskPrompt": "p",
            "boardProfileId": "bp",
            "status": "planning",
            "createdAt": iso_now(),
            "updatedAt": iso_now(),
            "iteration": 1,
        }
    )
    with pytest.raises(ContractViolation, match="terminal"):
        rec.close()


def test_recorder_rejects_illegal_transition(tmp_path):
    rec = RunRecorder(tmp_path / "rec", "run_test_004", REPO_ROOT)
    rec.run_created(
        {
            "id": rec.run_id,
            "title": "t",
            "taskPrompt": "p",
            "boardProfileId": "bp",
            "status": "planning",
            "createdAt": iso_now(),
            "updatedAt": iso_now(),
            "iteration": 1,
        }
    )
    with pytest.raises(ContractViolation, match="illegal status transition"):
        rec.status_changed("diagnosing")  # planning -> diagnosing is not a §5.7 edge


def test_recorder_rejects_contract_invalid_payload(tmp_path):
    rec = RunRecorder(tmp_path / "rec", "run_test_005", REPO_ROOT)
    with pytest.raises(ContractViolation):
        rec.emit("run.created", {"run": {"id": "x"}})  # missing required Run fields


def test_recorder_refuses_to_append_to_existing_recording(tmp_path):
    (tmp_path / "rec").mkdir()
    (tmp_path / "rec" / "recorded_run.jsonl").write_text("{}\n")
    with pytest.raises(ContractViolation, match="already exists"):
        RunRecorder(tmp_path / "rec", "run_test_006", REPO_ROOT)


def test_delay_ms_is_capped(tmp_path, monkeypatch):
    rec = RunRecorder(tmp_path / "rec", "run_test_007", REPO_ROOT)
    fake_now = [100.0]
    monkeypatch.setattr("agent_spike.recorder.time.monotonic", lambda: fake_now[0])
    rec.run_created(
        {
            "id": rec.run_id,
            "title": "t",
            "taskPrompt": "p",
            "boardProfileId": "bp",
            "status": "planning",
            "createdAt": iso_now(),
            "updatedAt": iso_now(),
            "iteration": 1,
        }
    )
    fake_now[0] += 300.0  # five minutes of model thinking
    rec.status_changed("plan_ready")
    lines = [json.loads(l) for l in (tmp_path / "rec" / "recorded_run.jsonl").read_text().splitlines()]
    assert lines[1]["delayMs"] == 20000
