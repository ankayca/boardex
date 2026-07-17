"""Bounds enforcement (spec §3.3/§3.4): exceeding --max-turns or
--max-iterations terminates the run as failed, with a partial report attempt."""

from __future__ import annotations

from conftest import (
    VALID_PLAN_ARGS,
    FakeProvider,
    ScriptedApprover,
    build_harness,
    make_turn,
    read_events,
)


async def test_max_turns_exceeded_fails_with_partial_report(tmp_path, task_repo):
    filler = make_turn(calls=[("read_file", {"path": "main.c"})])  # busy-loops forever
    report = make_turn(calls=[("write_report", {"markdown": "# Partial\nRan out of budget."})])
    provider = FakeProvider(
        [make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)])], filler=filler, report_turn=report
    )
    harness = build_harness(
        tmp_path, task_repo, provider, ScriptedApprover([True]), max_turns=4
    )
    terminal = await harness.run()
    assert terminal == "failed"

    events = [e["event"] for e in read_events(tmp_path / "record")]
    assert events[-1]["type"] == "run.failed"
    assert "turn bound" in events[-1]["payload"]["summary"]
    assert "partial report attached" in events[-1]["payload"]["summary"]
    # the partial report artifact exists and precedes the terminal event
    report_artifacts = [
        e for e in events
        if e["type"] == "artifact.created" and e["payload"]["artifact"]["kind"] == "report_md"
    ]
    assert len(report_artifacts) == 1


async def test_max_turns_without_report_still_fails_cleanly(tmp_path, task_repo):
    filler = make_turn(content="thinking out loud, no tools")  # stalls
    provider = FakeProvider(
        [make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)])], filler=filler, report_turn=filler
    )
    harness = build_harness(
        tmp_path, task_repo, provider, ScriptedApprover([True]), max_turns=10
    )
    terminal = await harness.run()
    assert terminal == "failed"
    events = [e["event"] for e in read_events(tmp_path / "record")]
    assert events[-1]["type"] == "run.failed"
    # stall detection tripped before the turn bound
    assert "stalled" in events[-1]["payload"]["summary"]


async def test_iteration_bound_enforced(tmp_path, task_repo):
    report = make_turn(calls=[("write_report", {"markdown": "# Partial\nIteration cap."})])
    script = [
        make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(calls=[("declare_iteration", {"reason": "fix attempt 2"})]),
        make_turn(calls=[("declare_iteration", {"reason": "fix attempt 3"})]),  # exceeds cap
    ]
    provider = FakeProvider(script, report_turn=report)
    harness = build_harness(
        tmp_path, task_repo, provider, ScriptedApprover([True]), max_iterations=2
    )
    terminal = await harness.run()
    assert terminal == "failed"

    events = [e["event"] for e in read_events(tmp_path / "record")]
    iter_events = [e for e in events if e["type"] == "run.iteration_started"]
    assert [e["payload"]["iteration"] for e in iter_events] == [2]  # 3 never started
    assert events[-1]["type"] == "run.failed"
    assert "iteration bound" in events[-1]["payload"]["summary"]
