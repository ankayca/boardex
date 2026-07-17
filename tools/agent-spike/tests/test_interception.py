"""Interception fires BEFORE the MCP invocation for risk-listed tools, and the
gate floor cannot be bypassed: rejection means the tool never runs and the run
ends stopped."""

from __future__ import annotations

from agent_spike.interception import is_risk_gated

from conftest import (
    VALID_PLAN_ARGS,
    FakeProvider,
    FakeToolHost,
    ScriptedApprover,
    build_harness,
    make_turn,
    read_events,
)

FLASH_DESC = "Flash a firmware image (.elf/.hex/.bin) onto a target and reset it."


def test_risk_list_floor():
    # name-prefix floor
    assert is_risk_gated("flash_firmware", "")
    assert is_risk_gated("reset_target", "")
    assert is_risk_gated("write_memory", "")
    assert is_risk_gated("write_register", "")
    assert is_risk_gated("recover_target", "")
    assert is_risk_gated("erase_all", "")
    # composite floor
    assert is_risk_gated("run_checkpoint", "One-shot build → flash → RTT checkpoint")
    assert is_risk_gated("verify_bringup", "Verify sensor bring-up with RTT proof")
    # description floor: first line declares mutation
    assert is_risk_gated("mystery_tool", "Programs the target flash bank.\nMore detail.")
    # read-only tools stay ungated even when later lines mention reset_target
    assert not is_risk_gated(
        "capture_during",
        "Trigger-armed bus capture for sporadic traffic (I2C/SPI/UART/...).\n\n"
        "Coordinate with the target MCP: call ``reset_target`` on the MCU immediately before this tool.",
    )
    assert not is_risk_gated("build_firmware", "Build an external firmware project and return the built artifact path.")
    assert not is_risk_gated("read_memory", "Read ``length`` bytes from ``address``; returns hex in ``data.hex``.")


async def test_approved_gate_dispatches_after_approval_events(tmp_path, task_repo):
    host = FakeToolHost({"flash_firmware": FLASH_DESC})
    script = [
        make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(calls=[("flash_firmware", {"device_id": "pyocd:0", "firmware_path": "/x.elf"})]),
        make_turn(calls=[("write_report", {"markdown": "# done"})]),
        make_turn(calls=[("write_report", {"markdown": "# done"})]),
    ]
    harness = build_harness(
        tmp_path, task_repo, FakeProvider(script), ScriptedApprover([True, True]), toolhost=host
    )
    await harness.run()

    events = [e["event"] for e in read_events(tmp_path / "record")]
    types = [e["type"] for e in events]
    # order: awaiting_approval -> approval.requested -> approval.resolved -> running -> step.started(flash)
    i_req = types.index("approval.requested")
    i_res = types.index("approval.resolved")
    i_step = next(
        i for i, e in enumerate(events) if e["type"] == "step.started" and e["payload"]["step"]["kind"] == "flash"
    )
    assert i_req < i_res < i_step
    assert events[i_req - 1]["type"] == "run.status_changed"
    assert events[i_req - 1]["payload"]["status"] == "awaiting_approval"
    assert events[i_res]["payload"]["status"] == "approved"
    assert len(host.invocations) == 1  # dispatched exactly once, after approval


async def test_rejected_gate_never_dispatches_and_stops_run(tmp_path, task_repo):
    host = FakeToolHost({"flash_firmware": FLASH_DESC})
    script = [
        make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(calls=[("flash_firmware", {"device_id": "pyocd:0", "firmware_path": "/x.elf"})]),
    ]
    harness = build_harness(
        tmp_path, task_repo, FakeProvider(script), ScriptedApprover([True, False]), toolhost=host
    )
    terminal = await harness.run()
    assert terminal == "stopped"
    assert host.invocations == []  # the MCP call never happened

    events = [e["event"] for e in read_events(tmp_path / "record")]
    types = [e["type"] for e in events]
    assert types[-1] == "run.stopped"
    assert types[-2] == "run.status_changed"
    assert events[-2]["payload"]["status"] == "stopped"
    resolved = next(e for e in events if e["type"] == "approval.resolved")
    assert resolved["payload"]["status"] == "rejected"
    # no flash step ever started
    assert not any(
        e["type"] == "step.started" and e["payload"]["step"]["kind"] == "flash" for e in events
    )


async def test_ungated_tool_runs_without_approval(tmp_path, task_repo):
    host = FakeToolHost(
        {"build_firmware": "Build an external firmware project and return the built artifact path."},
        results={"build_firmware": {"verdict": "pass", "data": {"stdout": "make: ok", "artifact_path": "/x.elf"}}},
    )
    script = [
        make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(calls=[("build_firmware", {"project_dir": "/proj"})]),
        make_turn(calls=[("write_report", {"markdown": "# done"})]),
        make_turn(calls=[("write_report", {"markdown": "# done"})]),
    ]
    approver = ScriptedApprover([True])  # only the plan gate
    harness = build_harness(tmp_path, task_repo, FakeProvider(script), approver, toolhost=host)
    await harness.run()
    assert len(host.invocations) == 1
    events = [e["event"] for e in read_events(tmp_path / "record")]
    # exactly zero approval.requested beyond none (plan gate is not an approval event)
    assert not any(e["type"] == "approval.requested" for e in events)
    # build log artifact captured, step stream is 'build'
    assert any(
        e["type"] == "artifact.created" and e["payload"]["artifact"]["kind"] == "build_log"
        for e in events
    )
    logs = [e for e in events if e["type"] == "step.log" and e["payload"].get("stream") == "build"]
    assert logs and logs[0]["payload"]["lines"] == ["make: ok"]
