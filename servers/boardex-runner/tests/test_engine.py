"""Engine conformance: §5.7 transitions, gapless seq, approvals, stop, evidence."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from boardex_runner.artifacts import ArtifactStore
from boardex_runner.contract import (
    STATUS_TRANSITIONS,
    TERMINAL_STATUSES,
    validate_event,
)

from conftest import drive_to_terminal, make_engine, pending_approval_id, run


def assert_wire_conformant(events: list[dict[str, Any]]) -> None:
    """The §5 invariants every stream must satisfy."""
    assert events, "stream is empty"
    for i, event in enumerate(events):
        assert event["seq"] == i + 1, "seq must be gapless from 1"
        validate_event(event)
    assert events[0]["type"] == "run.created", "first known event must be run.created"
    # §5.7: replayed status transitions follow the graph.
    status = "draft"
    for event in events:
        new_status: str | None = None
        if event["type"] == "run.created":
            new_status = event["payload"]["run"]["status"]
        elif event["type"] == "run.status_changed":
            new_status = event["payload"]["status"]
        elif event["type"] in ("run.completed", "run.failed", "run.stopped"):
            new_status = event["type"].split(".")[1]
        if new_status is None or new_status == status:
            continue
        assert new_status in STATUS_TRANSITIONS[status] or (
            # run.created carries the initial planning status (draft -> planning).
            event["type"] == "run.created"
            and new_status == "planning"
        ), f"illegal transition {status} -> {new_status} at seq {event['seq']}"
        status = new_status
    # Terminal is terminal: nothing follows the dedicated terminal event.
    terminal_indexes = [
        i
        for i, event in enumerate(events)
        if event["type"] in ("run.completed", "run.failed", "run.stopped")
    ]
    if terminal_indexes:
        assert terminal_indexes[0] == len(events) - 1


def test_happy_path_completes_with_two_approvals_and_iteration_2() -> None:
    engine = make_engine()
    events = run(drive_to_terminal(engine))
    assert_wire_conformant(events)

    assert events[-1]["type"] == "run.completed"
    assert engine.status == "completed"

    approvals = [e for e in events if e["type"] == "approval.requested"]
    resolutions = [e for e in events if e["type"] == "approval.resolved"]
    assert len(approvals) == 2  # flash gate + fix gate
    assert len(resolutions) == 2
    assert all(e["payload"]["status"] == "approved" for e in resolutions)

    iterations = [e for e in events if e["type"] == "run.iteration_started"]
    assert len(iterations) == 1
    assert iterations[0]["payload"]["iteration"] == 2

    checks = [e["payload"]["check"] for e in events if e["type"] == "check.evaluated"]
    assert len(checks) == 6  # 3 per iteration
    assert [c["verdict"] for c in checks[-3:]] == ["pass", "pass", "pass"]

    # plan_ready was reported BEFORE the plan gate blocked (§5.7 rule 2).
    types = [e["type"] for e in events]
    plan_generated_at = types.index("run.plan_generated")
    plan_ready_at = next(
        i
        for i, e in enumerate(events)
        if e["type"] == "run.status_changed" and e["payload"]["status"] == "plan_ready"
    )
    assert plan_ready_at < plan_generated_at

    # The report artifact referenced by run.completed resolves.
    report_id = events[-1]["payload"]["reportArtifactId"]
    assert engine.artifacts.get(report_id) is not None


def test_evidence_law_every_check_artifact_resolves() -> None:
    engine = make_engine()
    events = run(drive_to_terminal(engine))
    announced = {
        e["payload"]["artifact"]["id"] for e in events if e["type"] == "artifact.created"
    }
    checks = [e["payload"]["check"] for e in events if e["type"] == "check.evaluated"]
    assert checks
    for check in checks:
        assert check["artifactId"] in announced
        stored = engine.artifacts.get(check["artifactId"])
        assert stored is not None
        assert stored.meta["sizeBytes"] == len(stored.content)
    # artifact.created precedes any check citing it, and precedes step completion.
    seq_by_artifact = {
        e["payload"]["artifact"]["id"]: e["seq"]
        for e in events
        if e["type"] == "artifact.created"
    }
    for event in events:
        if event["type"] == "check.evaluated":
            check = event["payload"]["check"]
            assert seq_by_artifact[check["artifactId"]] < event["seq"]


def test_step_logs_are_batched() -> None:
    events = run(drive_to_terminal(make_engine()))
    logs = [e for e in events if e["type"] == "step.log"]
    assert logs
    # ≤10 Hz discipline: the engine emits batched lines[], never per-line frames.
    assert all("lines" in e["payload"] for e in logs)


def test_approvals_block_hardware_until_resolution() -> None:
    async def scenario() -> None:
        engine = make_engine()
        engine.start()
        # Wait for the plan gate, approve, then wait for the flash approval.
        for _ in range(10_000):
            if engine.status == "plan_ready":
                break
            await asyncio.sleep(0.001)
        engine.approve_plan()
        for _ in range(10_000):
            if pending_approval_id(engine.log.events):
                break
            await asyncio.sleep(0.001)
        assert engine.status == "awaiting_approval"
        seq_at_gate = len(engine.log.events)
        # While the approval is pending, nothing further may be emitted.
        await asyncio.sleep(0.05)
        assert len(engine.log.events) == seq_at_gate
        types_so_far = {e["type"] for e in engine.log.events}
        assert not any(
            e["type"] == "step.started" and e["payload"]["step"]["kind"] == "flash"
            for e in engine.log.events
        ), "flash must not start before the approval resolves"
        assert "step.started" in types_so_far  # earlier steps did run
        await drive_to_terminal(engine)

    run(scenario())


def test_fail_variant_ends_failed_with_no_further_approval() -> None:
    engine = make_engine(fail_variant=True)
    events = run(drive_to_terminal(engine))
    assert_wire_conformant(events)
    assert events[-1]["type"] == "run.failed"
    assert engine.status == "failed"
    # Both approvals belong to the story; nothing new after iteration 2 fails.
    diagnosing_seqs = [
        e["seq"]
        for e in events
        if e["type"] == "run.status_changed" and e["payload"]["status"] == "diagnosing"
    ]
    assert len(diagnosing_seqs) == 2
    last_diagnosing = diagnosing_seqs[-1]
    assert not any(
        e["type"] == "approval.requested" and e["seq"] > last_diagnosing for e in events
    )
    # diagnosis.created was emitted for the final diagnosing pass too (§5.7 rule 4).
    assert any(
        e["type"] == "diagnosis.created" and e["seq"] > last_diagnosing for e in events
    )


def test_reject_routes_to_stopped_ending() -> None:
    engine = make_engine()
    events = run(drive_to_terminal(engine, resolve="rejected"))
    assert_wire_conformant(events)
    assert events[-1]["type"] == "run.stopped"
    assert events[-1]["payload"] == {"byUser": True}
    resolution = next(e for e in events if e["type"] == "approval.resolved")
    assert resolution["payload"]["status"] == "rejected"
    assert engine.status == "stopped"


def test_stop_mid_run_is_immediate_and_second_stop_conflicts() -> None:
    async def scenario() -> None:
        engine = make_engine()
        engine.start()
        for _ in range(10_000):
            if engine.status == "running":
                break
            if engine.status == "plan_ready":
                engine.approve_plan()
            await asyncio.sleep(0.001)
        assert engine.stop() is None  # 204
        events = engine.log.events
        assert events[-1]["type"] == "run.stopped"
        assert events[-2]["type"] == "run.status_changed"
        assert events[-2]["payload"]["status"] == "stopped"
        assert engine.status == "stopped"
        count = len(events)
        await asyncio.sleep(0.05)
        assert len(engine.log.events) == count, "no events after the terminal stop"
        conflict = engine.stop()
        assert conflict is not None
        assert conflict.current_status == "stopped"
        assert_wire_conformant(engine.log.events)

    run(scenario())


def test_stop_that_beats_run_created_still_yields_reducible_stream() -> None:
    async def scenario() -> None:
        engine = make_engine()
        engine.start()
        assert engine.stop() is None  # immediately, before run.created replays
        events = engine.log.events
        assert events[0]["type"] == "run.created"
        assert events[-1]["type"] == "run.stopped"
        assert_wire_conformant(events)
        await asyncio.sleep(0.05)
        assert len(engine.log.events) == len(events)

    run(scenario())


def test_commands_invalid_for_state_conflict() -> None:
    async def scenario() -> None:
        engine = make_engine()
        engine.start()
        # No plan gate yet -> conflict.
        conflict = engine.approve_plan()
        assert conflict is not None and conflict.current_status in (
            "draft",
            "planning",
        )
        conflict = engine.resolve_approval("apr_nope", "approved")
        assert conflict is not None
        events = await drive_to_terminal(engine)
        # Double-approving the (now resolved) plan conflicts.
        assert engine.approve_plan() is not None
        resolved = next(e for e in events if e["type"] == "approval.resolved")
        conflict = engine.resolve_approval(resolved["payload"]["approvalId"], "approved")
        assert conflict is not None
        assert conflict.current_status in TERMINAL_STATUSES

    run(scenario())


def test_replay_after_seq_filters_correctly() -> None:
    engine = make_engine()
    events = run(drive_to_terminal(engine))
    total = len(events)
    replay = engine.events_after(40)
    assert [e["seq"] for e in replay] == list(range(41, total + 1))
    assert engine.events_after(0) == events
    assert engine.events_after(total) == []


def test_run_summary_is_valid_before_run_created() -> None:
    async def scenario() -> None:
        engine = make_engine()
        engine.start()
        summary = engine.summary()
        assert summary["status"] == "draft"
        assert summary["title"]
        assert summary["boardProfileId"] == "bp_nucleo_f303re"
        assert summary["updatedAt"]
        await drive_to_terminal(engine)

    run(scenario())


def test_artifact_store_rejects_nonconforming_structured_content() -> None:
    from boardex_runner.contract import ContractViolation

    store = ArtifactStore()
    with pytest.raises(ContractViolation):
        store.put(
            artifact_id="art_bad",
            run_id="run_x",
            step_id="st_x",
            kind="protocol_decode",
            label="bad decode",
            content={"protocol": "i2c"},  # missing required fields
        )
