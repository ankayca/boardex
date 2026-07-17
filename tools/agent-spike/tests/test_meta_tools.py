"""Meta-tool payload validation: valid payloads emit contract events; a
malformed payload fails visibly with one retry; a second malformed payload
aborts the run as failed (spec §3.5 fail closed)."""

from __future__ import annotations

import json

from conftest import (
    VALID_PLAN_ARGS,
    FakeProvider,
    ScriptedApprover,
    build_harness,
    make_turn,
    read_events,
)

REPORT_ARGS = {"markdown": "# Report\nAll good. Evidence: build log artifact."}


async def test_valid_flow_completes(tmp_path, task_repo):
    """declare_plan -> write_file -> record_check(pass) -> write_report => run.completed."""
    script = [
        make_turn(content="Planning.", calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(
            content="Editing.",
            calls=[("write_file", {"path": "main.c", "content": "int main(void){return 1;}\n", "reason": "test edit"})],
        ),
        # The write_file step recorded a code_diff artifact with id art_001_code_diff.
        make_turn(
            calls=[
                (
                    "record_check",
                    {
                        "requirementId": "build_ok",
                        "actual": {"value": "0"},
                        "verdict": "pass",
                        "artifactId": "art_001_code_diff",
                    },
                )
            ]
        ),
        make_turn(calls=[("write_report", REPORT_ARGS)]),
    ]
    harness = build_harness(tmp_path, task_repo, FakeProvider(script), ScriptedApprover([True]))
    terminal = await harness.run()
    assert terminal == "completed"

    events = [e["event"] for e in read_events(tmp_path / "record")]
    types = [e["type"] for e in events]
    assert types[0] == "run.created"
    assert "run.plan_generated" in types
    assert "check.evaluated" in types
    assert types[-1] == "run.completed"
    completed = events[-1]
    assert completed["payload"]["reportArtifactId"].startswith("art_")
    # plan_ready must precede plan approval's running transition (§5.7 rule 2)
    statuses = [e["payload"]["status"] for e in events if e["type"] == "run.status_changed"]
    assert statuses[:2] == ["plan_ready", "running"]


async def test_malformed_plan_gets_one_retry(tmp_path, task_repo):
    bad = dict(VALID_PLAN_ARGS)
    bad = {k: v for k, v in bad.items() if k != "risk_summary"}  # missing required field
    script = [
        make_turn(calls=[("declare_plan", bad)]),
        make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(calls=[("write_report", REPORT_ARGS)]),
        make_turn(calls=[("write_report", REPORT_ARGS)]),  # second call accepts failed ending
    ]
    harness = build_harness(tmp_path, task_repo, FakeProvider(script), ScriptedApprover([True]))
    terminal = await harness.run()
    # Retry consumed, plan accepted; run ends failed because build_ok never recorded.
    assert terminal == "failed"
    # The first declare_plan response must carry the schema error.
    error_msgs = [
        m for m in harness.messages if m.get("role") == "tool" and "schema_errors" in str(m.get("content"))
    ]
    assert error_msgs, "model was never told why the payload failed"
    assert "risk_summary" in error_msgs[0]["content"]


async def test_second_malformed_payload_aborts_run_failed(tmp_path, task_repo):
    bad_check = {"requirementId": "build_ok", "verdict": "pass"}  # missing actual + artifactId
    script = [
        make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(calls=[("record_check", bad_check)]),
        make_turn(calls=[("record_check", bad_check)]),
    ]
    harness = build_harness(tmp_path, task_repo, FakeProvider(script), ScriptedApprover([True]))
    terminal = await harness.run()
    assert terminal == "failed"
    events = [e["event"] for e in read_events(tmp_path / "record")]
    assert events[-1]["type"] == "run.failed"
    assert "record_check" in events[-1]["payload"]["summary"]


async def test_record_check_enforces_evidence_law(tmp_path, task_repo):
    """A check citing a nonexistent artifact is rejected (and the run aborts on
    the second offense — evidence cannot be invented)."""
    ghost = {
        "requirementId": "build_ok",
        "actual": {"value": "0"},
        "verdict": "pass",
        "artifactId": "art_does_not_exist",
    }
    script = [
        make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(calls=[("record_check", ghost)]),
        make_turn(calls=[("record_check", ghost)]),
    ]
    harness = build_harness(tmp_path, task_repo, FakeProvider(script), ScriptedApprover([True]))
    terminal = await harness.run()
    assert terminal == "failed"
    events = [e["event"] for e in read_events(tmp_path / "record")]
    assert not any(e["type"] == "check.evaluated" for e in events)


async def test_write_report_with_failing_check_ends_failed(tmp_path, task_repo):
    script = [
        make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(
            calls=[("write_file", {"path": "main.c", "content": "x\n", "reason": "edit"})]
        ),
        make_turn(
            calls=[
                (
                    "record_check",
                    {
                        "requirementId": "build_ok",
                        "actual": {"value": "1"},
                        "verdict": "fail",
                        "artifactId": "art_001_code_diff",
                    },
                )
            ]
        ),
        make_turn(calls=[("write_report", {"markdown": "# Honest failure"})]),
    ]
    harness = build_harness(tmp_path, task_repo, FakeProvider(script), ScriptedApprover([True]))
    terminal = await harness.run()
    assert terminal == "failed"
    events = [e["event"] for e in read_events(tmp_path / "record")]
    assert events[-1]["type"] == "run.failed"
    assert "build_ok" in events[-1]["payload"]["summary"]
    # the report artifact still exists (evidence retained on failure)
    assert any(
        e["type"] == "artifact.created" and e["payload"]["artifact"]["kind"] == "report_md"
        for e in events
    )


async def test_plan_rejection_stops_run(tmp_path, task_repo):
    script = [make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)])]
    harness = build_harness(tmp_path, task_repo, FakeProvider(script), ScriptedApprover([False]))
    terminal = await harness.run()
    assert terminal == "stopped"
    events = [e["event"] for e in read_events(tmp_path / "record")]
    assert [e["type"] for e in events[-2:]] == ["run.status_changed", "run.stopped"]
    assert events[-2]["payload"]["status"] == "stopped"
    assert events[-1]["payload"] == {"byUser": True}
