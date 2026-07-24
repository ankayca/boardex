"""Agent-bench conformance: the scripted-LLM deterministic loop through the
real engine and wire layer — plan gate, tool-call interception with the
hardcoded gate floor, stop-as-hard-cancel, fail-closed meta-tools, bounds."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from boardex_runner.agent_bench import (
    DEFAULT_MAX_TURNS,
    AgentBench,
    SizePolicy,
    _bounded_log_text,
)
from boardex_runner.interception import is_risk_gated
from boardex_runner.prompts import SYSTEM_PROMPT

from conftest import (
    BUILD_DESC,
    FLASH_DESC,
    VALID_PLAN_ARGS,
    FakeProvider,
    FakeToolHost,
    HangingProvider,
    agent_profile,
    drive_to_terminal,
    make_agent_engine,
    make_turn,
    run,
)
from test_engine import assert_wire_conformant


@pytest.fixture
def task_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "task-repo"
    repo.mkdir()
    (repo / "main.c").write_text("int main(void) { return 0; }\n")
    return repo


def test_agent_turn_budget_default_is_60() -> None:
    # Hardware runs burn turns on tool failures; the BMP180 run died at 40 with
    # one check unrecorded. The default budget is 60; the AGENT_MAX_TURNS env
    # override seam is unchanged (an explicit budget still wins).
    assert DEFAULT_MAX_TURNS == 60
    assert AgentBench().max_turns == 60
    assert AgentBench(max_turns=25).max_turns == 25


def test_system_prompt_pins_fault_domain_discrimination() -> None:
    # Layer-1 hardware fault discrimination (prompts-only; the structured
    # diagnosis category field is the v2.5 layer-2 companion). Run 2's
    # iteration 2 ended with a live bus still NACKing at a plausible address —
    # the shape where an agent burns iterations rewriting correct code while
    # the fault is physical. Pin the section's key signatures and the
    # protocol's hard rule so a prompt rewrite cannot silently drop them.
    assert "## Fault-domain discrimination" in SYSTEM_PROMPT
    # the signature table
    assert "Do not rewrite the driver." in SYSTEM_PROMPT
    assert "No firmware change can fix a held line." in SYSTEM_PROMPT
    assert "the fault is between the pin and the probe" in SYSTEM_PROMPT
    assert "decoders misframe at capture start" in SYSTEM_PROMPT
    assert "a one-bit-late frame of 0xEE reads as 0xDC" in SYSTEM_PROMPT
    assert '"target was not halted"' in SYSTEM_PROMPT
    assert "Only when the wire CONTRADICTS the code's intent" in SYSTEM_PROMPT
    # judgment license — signatures, not rigid if-then
    assert "signatures, not certainties" in SYSTEM_PROMPT
    # the discrimination protocol
    assert "before requesting ANY second fix-iteration" in SYSTEM_PROMPT
    assert "firmware, hardware, or instrumentation" in SYSTEM_PROMPT
    assert "profile's connection checklist" in SYSTEM_PROMPT
    assert (
        "what to check with a multimeter, not show them a fifth driver rewrite"
        in SYSTEM_PROMPT
    )


def test_risk_gate_floor() -> None:
    # name-prefix floor
    assert is_risk_gated("flash_firmware", "")
    assert is_risk_gated("reset_target", "")
    assert is_risk_gated("erase_all", "")
    assert is_risk_gated("write_memory", "")
    assert is_risk_gated("recover_target", "")
    # composite floor
    assert is_risk_gated("run_checkpoint", "One-shot build -> flash -> RTT checkpoint")
    assert is_risk_gated("verify_bringup", "Verify sensor bring-up with RTT proof")
    # description floor: first line declares mutation
    assert is_risk_gated("mystery_tool", "Programs the target flash bank.\nMore detail.")
    # read-only tools stay ungated even when later lines mention reset_target
    assert not is_risk_gated(
        "capture_during",
        "Trigger-armed bus capture for sporadic traffic (I2C/SPI/UART/...).\n\n"
        "Coordinate with the target MCP: call ``reset_target`` on the MCU immediately before this tool.",
    )
    assert not is_risk_gated("build_firmware", BUILD_DESC)
    assert not is_risk_gated("read_memory", "Read ``length`` bytes from ``address``.")
    # whitespace-only descriptions must not raise — the floor is a safety
    # classifier and has no failure mode
    assert not is_risk_gated("some_tool", "   ")
    assert not is_risk_gated("some_tool", "\n\n")
    assert not is_risk_gated("some_tool", None)
    # ...and a risky description still gates after leading blank lines
    assert is_risk_gated("some_tool", "\n\nErases the boot sector.")


def test_deterministic_loop_completes_through_the_wire_layer(task_repo: Path) -> None:
    """declare_plan -> plan gate -> write_file -> build -> gated flash ->
    record_check -> write_report => run.completed, every event contract-valid."""
    host = FakeToolHost(
        {"build_firmware": BUILD_DESC, "flash_firmware": FLASH_DESC},
        results={
            "build_firmware": {
                "verdict": "pass",
                "data": {"stdout": "make: ok", "artifact_path": "/x.elf"},
            }
        },
    )
    script = [
        make_turn(content="Planning.", calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(
            content="Editing.",
            calls=[("write_file", {"path": "main.c", "content": "int main(void){return 1;}\n", "reason": "test edit", "_plan_index": 1})],
        ),
        make_turn(calls=[("build_firmware", {"project_dir": "/proj", "_plan_index": 1})]),
        make_turn(calls=[("flash_firmware", {"device_id": "pyocd:0", "firmware_path": "/x.elf"})]),
        make_turn(
            calls=[
                (
                    "record_check",
                    {
                        "requirementId": "build_ok",
                        "actual": {"value": "0"},
                        "verdict": "pass",
                        "artifactId": "art_agent1_002_build_log",
                    },
                )
            ]
        ),
        make_turn(calls=[("write_report", {"markdown": "# Report\nBuild ok. Evidence: art_agent1_002_build_log."})]),
    ]
    engine = make_agent_engine(task_repo, FakeProvider(script), host)
    events = run(drive_to_terminal(engine))
    assert_wire_conformant(events)

    assert events[-1]["type"] == "run.completed"
    assert engine.status == "completed"
    # CreateRun.model echoed onto Run.model.
    assert events[0]["payload"]["run"]["model"] == "test-model"

    types = [e["type"] for e in events]
    # plan_ready precedes run.plan_generated (§5.7 rule 2), which precedes any step.
    plan_ready_at = next(
        i for i, e in enumerate(events)
        if e["type"] == "run.status_changed" and e["payload"]["status"] == "plan_ready"
    )
    assert plan_ready_at < types.index("run.plan_generated") < types.index("step.started")

    # The flash gate parked BEFORE the invocation: requested < resolved < flash step.
    i_req = types.index("approval.requested")
    i_res = types.index("approval.resolved")
    i_flash = next(
        i for i, e in enumerate(events)
        if e["type"] == "step.started" and e["payload"]["step"]["kind"] == "flash"
    )
    assert i_req < i_res < i_flash
    assert host.invocations == [
        ("build_firmware", {"project_dir": "/proj"}),  # _plan_index stripped
        ("flash_firmware", {"device_id": "pyocd:0", "firmware_path": "/x.elf"}),
    ]

    # write_file recorded a code_diff artifact; the check's evidence resolves.
    kinds = [
        e["payload"]["artifact"]["kind"] for e in events if e["type"] == "artifact.created"
    ]
    assert kinds == ["code_diff", "build_log", "flash_log", "report_md"]
    check = next(e["payload"]["check"] for e in events if e["type"] == "check.evaluated")
    assert check["artifactId"] == "art_agent1_002_build_log"
    assert engine.artifacts.get(check["artifactId"]) is not None

    # _plan_index bound the edit/build steps to plan row 1.
    steps = [e["payload"]["step"] for e in events if e["type"] == "step.started"]
    by_kind = {s["kind"]: s for s in steps}
    assert by_kind["edit_code"]["planIndex"] == 1
    assert by_kind["build"]["planIndex"] == 1

    # The report artifact referenced by run.completed resolves.
    report_id = events[-1]["payload"]["reportArtifactId"]
    assert engine.artifacts.get(report_id) is not None


def test_coordinated_i2c_capture_emits_decode_and_measured_timing_artifacts(
    task_repo: Path,
) -> None:
    tool = "reset_and_capture_i2c"
    host = FakeToolHost(
        {tool: "Reset-and-halt the MCU, arm an I2C capture, then resume the target."},
        results={
            tool: {
                "verdict": "pass",
                "data": {
                    "protocol": "i2c",
                    "device_id": "sigrok:la",
                    "channel_map": {"scl": 1, "sda": 0},
                    "sample_rate_hz": 4_000_000,
                    "num_samples": 400_000,
                    "duration_s": 0.1,
                    "bus_state": "decoded_ok",
                    "trigger_channel": 1,
                    "trigger_edge": "falling",
                    "annotations": [
                        {
                            "raw": "0-40 i2c-1: 0",
                            "start": 0,
                            "end": 40,
                            "decoder": "i2c-1",
                            "text": "0",
                        }
                    ],
                    "transactions": [
                        {
                            "addr_7bit": 0x77,
                            "rw": "r",
                            "write": [],
                            "read": [0x55],
                            "nack_at": None,
                        }
                    ],
                    "scl_frequency_hz": 100_000.0,
                    "capture_coordination": {"analyzer_armed_before_resume": True},
                },
            }
        },
    )
    plan = {**VALID_PLAN_ARGS, "checks": []}
    script = [
        make_turn(calls=[("declare_plan", plan)]),
        make_turn(
            calls=[
                (
                    tool,
                    {
                        "device_id": "pyocd:0",
                        "logic_analyzer_id": "sigrok:la",
                        "channel_map": {"scl": 1, "sda": 0},
                    },
                )
            ]
        ),
        make_turn(calls=[("write_report", {"markdown": "# Physical evidence complete"})]),
    ]
    engine = make_agent_engine(task_repo, FakeProvider(script), host)
    events = run(drive_to_terminal(engine))
    assert_wire_conformant(events)

    artifacts = [
        e["payload"]["artifact"] for e in events if e["type"] == "artifact.created"
    ]
    assert [a["kind"] for a in artifacts] == [
        "protocol_decode",
        "timing_measurement",
        "report_md",
    ]
    decode = engine.artifacts.get(artifacts[0]["id"])
    timing = engine.artifacts.get(artifacts[1]["id"])
    assert decode is not None and b"scl_frequency_hz" not in decode.content
    assert decode is not None and b"capture_coordination" not in decode.content
    assert timing is not None
    assert json.loads(timing.content) == {
        "measurement": "logic_analyzer.i2c.scl_frequency_hz",
        "valueHz": 100_000.0,
    }


def _tool_message(engine: Any, call_id: str) -> dict[str, Any]:
    return next(
        json.loads(m["content"])
        for m in engine._messages
        if m.get("role") == "tool" and m.get("tool_call_id") == call_id
    )


def test_decode_inline_echo_is_bounded_but_the_artifact_keeps_everything(
    task_repo: Path,
) -> None:
    """Size policy: the model sees the full transactions plus a bounded slice of
    annotations with a depth note; the protocol_decode artifact is untruncated."""
    tool = "capture_during"
    annotations = [
        {"raw": f"{i}-{i + 9} i2c-1: byte", "start": i, "end": i + 9, "decoder": "i2c-1", "text": "b"}
        for i in range(0, 1000, 10)
    ]
    transactions = [
        {"addr_7bit": 0x77, "rw": "r", "write": [], "read": [0x55], "nack_at": None}
    ]
    host = FakeToolHost(
        {tool: "Timed bus capture with protocol decode."},
        results={
            tool: {
                "verdict": "pass",
                "data": {
                    "protocol": "i2c",
                    "device_id": "sigrok:la",
                    "channel_map": {"scl": 1, "sda": 0},
                    "sample_rate_hz": 4_000_000,
                    "num_samples": 400_000,
                    "duration_s": 0.1,
                    "bus_state": "decoded_ok",
                    "trigger_channel": 1,
                    "trigger_edge": "falling",
                    "annotations": annotations,
                    "transactions": transactions,
                },
            }
        },
    )
    plan = {**VALID_PLAN_ARGS, "checks": []}
    script = [
        make_turn(calls=[("declare_plan", plan)]),
        make_turn(calls=[(tool, {"device_id": "sigrok:la", "protocol": "i2c"})]),
        make_turn(calls=[("write_report", {"markdown": "# done"})]),
    ]
    engine = make_agent_engine(task_repo, FakeProvider(script), host)
    events = run(drive_to_terminal(engine))
    assert_wire_conformant(events)

    echoed = _tool_message(engine, f"call_{tool}_0")["result"]["data"]
    assert len(echoed["annotations"]) == SizePolicy().decode_max_annotations == 40
    assert echoed["annotationsElided"] == 60
    # Under the default transactions bound this short summary rides in full,
    # so the note must not claim an elision that did not happen.
    assert echoed["transactions"] == transactions
    assert "transactionsElided" not in echoed
    assert "transactions" not in echoed["decodeNote"]
    decode_id = next(
        e["payload"]["artifact"]["id"]
        for e in events
        if e["type"] == "artifact.created"
        and e["payload"]["artifact"]["kind"] == "protocol_decode"
    )
    assert decode_id in echoed["decodeNote"]
    # The artifact itself is NEVER truncated.
    stored = json.loads(engine.artifacts.get(decode_id).content)
    assert len(stored["annotations"]) == 100
    assert stored["transactions"] == transactions


def test_build_log_inline_echo_keeps_error_lines_and_tail(task_repo: Path) -> None:
    lines = [f"compiling unit_{i}.c" for i in range(200)]
    lines[5] = "main.c:12: error: undefined reference to `bmp180_read'"
    stdout = "\n".join(lines)
    host = FakeToolHost(
        {"build_firmware": BUILD_DESC},
        results={"build_firmware": {"verdict": "pass", "data": {"stdout": stdout}}},
    )
    plan = {**VALID_PLAN_ARGS, "checks": []}
    script = [
        make_turn(calls=[("declare_plan", plan)]),
        make_turn(calls=[("build_firmware", {"project_dir": "/proj"})]),
        make_turn(calls=[("write_report", {"markdown": "# done"})]),
    ]
    engine = make_agent_engine(task_repo, FakeProvider(script), host)
    events = run(drive_to_terminal(engine))

    echoed = _tool_message(engine, "call_build_firmware_0")["result"]["data"]["stdout"]
    echoed_lines = echoed.splitlines()
    # note + 1 error line + the last 60 lines; the error line survived eliding.
    assert echoed_lines[0].startswith("[harness:")
    assert "error: undefined reference" in echoed_lines[1]
    assert echoed_lines[-1] == lines[-1]
    assert len(echoed_lines) == 1 + 1 + SizePolicy().log_tail_lines
    build_id = next(
        e["payload"]["artifact"]["id"]
        for e in events
        if e["type"] == "artifact.created"
        and e["payload"]["artifact"]["kind"] == "build_log"
    )
    assert build_id in echoed_lines[0]  # the note points at the full artifact
    assert stdout in engine.artifacts.get(build_id).content.decode()  # untruncated


def test_size_policy_is_env_tunable(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("AGENT_DECODE_MAX_ANNOTATIONS", "5")
    monkeypatch.setenv("AGENT_DECODE_MAX_TRANSACTIONS", "7")
    monkeypatch.setenv("AGENT_LOG_TAIL_LINES", "3")
    policy = SizePolicy.from_env()
    assert (policy.decode_max_annotations, policy.decode_max_transactions) == (5, 7)
    bounded = _bounded_log_text("\n".join(f"line{i}" for i in range(10)), "art_x", policy)
    assert bounded.splitlines()[-3:] == ["line7", "line8", "line9"]


@pytest.mark.parametrize(
    "var",
    [
        "AGENT_DECODE_MAX_ANNOTATIONS",
        "AGENT_DECODE_MAX_TRANSACTIONS",
        "AGENT_LOG_TAIL_LINES",
        "AGENT_LOG_ERROR_LINES",
    ],
)
@pytest.mark.parametrize("bad", ["0", "-1", "nope"])
def test_invalid_cap_fails_at_bench_construction_not_mid_run(monkeypatch, var, bad) -> None:  # type: ignore[no-untyped-def]
    """F4: an operator typo must stop the process at startup — discovering it
    at the first tool result means failing hours into a hardware run."""
    monkeypatch.setenv(var, bad)
    with pytest.raises(SystemExit):
        AgentBench()


def test_bounded_decode_stays_well_formed_json_under_the_cap(task_repo: Path) -> None:
    """F3: with both sequences bounded by element count, the inline echo of a
    pathologically large decode parses — TOOL_RESULT_CAP never cuts mid-JSON."""
    tool = "capture_during"
    host = FakeToolHost(
        {tool: "Timed bus capture with protocol decode."},
        results={
            tool: {
                "verdict": "pass",
                "data": {
                    "protocol": "i2c",
                    "device_id": "sigrok:la",
                    "channel_map": {"scl": 1, "sda": 0},
                    "sample_rate_hz": 4_000_000,
                    "num_samples": 400_000,
                    "duration_s": 0.1,
                    "bus_state": "decoded_ok",
                    "trigger_channel": 1,
                    "trigger_edge": "falling",
                    "annotations": [
                        {"raw": "x" * 200, "start": i, "end": i + 1, "decoder": "i2c-1", "text": "b"}
                        for i in range(5000)
                    ],
                    "transactions": [
                        {
                            "addr_7bit": 0x77,
                            "rw": "r",
                            "write": [],
                            "read": [0x55] * 50,
                            "nack_at": None,
                        }
                        for _ in range(5000)
                    ],
                },
            }
        },
    )
    plan = {**VALID_PLAN_ARGS, "checks": []}
    script = [
        make_turn(calls=[("declare_plan", plan)]),
        make_turn(calls=[(tool, {"device_id": "sigrok:la", "protocol": "i2c"})]),
        make_turn(calls=[("write_report", {"markdown": "# done"})]),
    ]
    engine = make_agent_engine(task_repo, FakeProvider(script), host)
    events = run(drive_to_terminal(engine))

    raw = next(
        m["content"]
        for m in engine._messages
        if m.get("role") == "tool" and m.get("tool_call_id") == f"call_{tool}_0"
    )
    assert "[truncated" not in raw, "the cap still had to cut — bounds are not doing their job"
    echoed = json.loads(raw)["result"]["data"]  # parses => well-formed
    # Both sequences were trimmed: the count bound first, then the size fit
    # (200 transactions of 50 read bytes each still overruns the cap).
    assert 0 < len(echoed["transactions"]) < SizePolicy().decode_max_transactions
    assert 0 < len(echoed["annotations"]) <= SizePolicy().decode_max_annotations
    kept_tx, kept_ann = len(echoed["transactions"]), len(echoed["annotations"])
    assert echoed["transactionsElided"] == 5000 - kept_tx
    assert echoed["annotationsElided"] == 5000 - kept_ann
    # The note reports what actually survived, not the nominal limit.
    assert f"the first {kept_tx} of 5000 transactions" in echoed["decodeNote"]
    assert f"the first {kept_ann} of 5000 annotations" in echoed["decodeNote"]
    # The artifact still holds everything.
    decode_id = next(
        e["payload"]["artifact"]["id"]
        for e in events
        if e["type"] == "artifact.created"
        and e["payload"]["artifact"]["kind"] == "protocol_decode"
    )
    stored = json.loads(engine.artifacts.get(decode_id).content)
    assert len(stored["annotations"]) == len(stored["transactions"]) == 5000


def test_short_results_ride_inline_untouched(task_repo: Path) -> None:
    result = {"verdict": "pass", "data": {"stdout": "make: ok", "annotations": []}}
    host = FakeToolHost({"build_firmware": BUILD_DESC}, results={"build_firmware": result})
    plan = {**VALID_PLAN_ARGS, "checks": []}
    script = [
        make_turn(calls=[("declare_plan", plan)]),
        make_turn(calls=[("build_firmware", {"project_dir": "/proj"})]),
        make_turn(calls=[("write_report", {"markdown": "# done"})]),
    ]
    engine = make_agent_engine(task_repo, FakeProvider(script), host)
    run(drive_to_terminal(engine))
    assert _tool_message(engine, "call_build_firmware_0")["result"] == result


def test_usage_lands_as_quiet_agent_log_lines_plus_a_run_total(task_repo: Path) -> None:
    """Per-call litellm usage rides the agent step.log stream — one line per
    turn, flushed with the next step — and the report step logs the run total."""
    usage_1 = {"prompt_tokens": 4000, "completion_tokens": 100, "cached_tokens": 3800}
    usage_2 = {"prompt_tokens": 4500, "completion_tokens": 60, "cached_tokens": 4200}
    usage_3 = {"prompt_tokens": 4700, "completion_tokens": 200}
    host = FakeToolHost(
        {"build_firmware": BUILD_DESC},
        results={"build_firmware": {"verdict": "pass", "data": {"stdout": "ok"}}},
    )
    plan = {**VALID_PLAN_ARGS, "checks": []}
    script = [
        make_turn(calls=[("declare_plan", plan)], usage=usage_1),
        make_turn(calls=[("build_firmware", {"project_dir": "/proj"})], usage=usage_2),
        make_turn(calls=[("write_report", {"markdown": "# done"})], usage=usage_3),
    ]
    engine = make_agent_engine(task_repo, FakeProvider(script), host)
    events = run(drive_to_terminal(engine))
    assert_wire_conformant(events)
    assert events[-1]["type"] == "run.completed"

    agent_logs = [
        e["payload"]
        for e in events
        if e["type"] == "step.log" and e["payload"]["stream"] == "agent"
    ]
    usage_lines = [
        ln
        for p in agent_logs
        for ln in (p.get("lines") or [p.get("line", "")])
        if ln.startswith("usage:")
    ]
    # One line per provider call, in order, with the cache detail present.
    assert usage_lines[:3] == [
        "usage: turn 1 in=4000 out=100 cache_read=3800",
        "usage: turn 2 in=4500 out=60 cache_read=4200",
        "usage: turn 3 in=4700 out=200",
    ]
    # The report step carries the run total (summed across all calls).
    assert usage_lines[-1] == "usage: run total (3 calls) in=13200 out=360 cache_read=8000"
    report_step = next(
        e["payload"]["step"]["id"]
        for e in events
        if e["type"] == "step.started" and e["payload"]["step"]["kind"] == "report"
    )
    total_log = next(p for p in agent_logs if p.get("line", "").startswith("usage: run total"))
    assert total_log["stepId"] == report_step


def test_runs_without_usage_emit_no_usage_lines(task_repo: Path) -> None:
    plan = {**VALID_PLAN_ARGS, "checks": []}
    script = [
        make_turn(calls=[("declare_plan", plan)]),
        make_turn(calls=[("write_report", {"markdown": "# done"})]),
    ]
    engine = make_agent_engine(task_repo, FakeProvider(script))
    events = run(drive_to_terminal(engine))
    assert not any(
        "usage:" in ln
        for e in events
        if e["type"] == "step.log"
        for ln in (e["payload"].get("lines") or [e["payload"].get("line", "")])
    )


def test_rejected_gate_never_dispatches_and_stops_run(task_repo: Path) -> None:
    host = FakeToolHost({"flash_firmware": FLASH_DESC})
    script = [
        make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(calls=[("flash_firmware", {"device_id": "pyocd:0", "firmware_path": "/x.elf"})]),
    ]
    engine = make_agent_engine(task_repo, FakeProvider(script), host)
    events = run(drive_to_terminal(engine, resolve="rejected"))
    assert_wire_conformant(events)

    assert engine.status == "stopped"
    assert events[-1]["type"] == "run.stopped"
    assert events[-1]["payload"] == {"byUser": True}
    resolution = next(e for e in events if e["type"] == "approval.resolved")
    assert resolution["payload"]["status"] == "rejected"
    # The tool was provably never invoked and no flash step ever started.
    assert host.invocations == []
    assert not any(
        e["type"] == "step.started" and e["payload"]["step"]["kind"] == "flash"
        for e in events
    )


def test_gate_floor_survives_falsey_flash_requires_approval(task_repo: Path) -> None:
    """Audit MEDIUM-5: a profile with flashRequiresApproval=false must NOT
    disable the gate — the hardcoded floor intercepts flash regardless."""
    host = FakeToolHost({"flash_firmware": FLASH_DESC})
    script = [
        make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(calls=[("flash_firmware", {"device_id": "pyocd:0", "firmware_path": "/x.elf"})]),
        make_turn(calls=[("write_report", {"markdown": "# done"})]),
        make_turn(calls=[("write_report", {"markdown": "# done"})]),  # accepts honest failure
    ]
    profile = agent_profile(task_repo, flashRequiresApproval=False)
    engine = make_agent_engine(task_repo, FakeProvider(script), host, profile=profile)
    events = run(drive_to_terminal(engine))
    assert_wire_conformant(events)

    types = [e["type"] for e in events]
    i_req = types.index("approval.requested")  # approval STILL requested
    i_flash = next(
        i for i, e in enumerate(events)
        if e["type"] == "step.started" and e["payload"]["step"]["kind"] == "flash"
    )
    assert i_req < i_flash
    assert len(host.invocations) == 1  # dispatched exactly once, after approval


def test_repeated_hardware_actions_gate_individually_and_step_ids_never_collide(
    task_repo: Path,
) -> None:
    """Two audit assumptions resolved: N approval gates per iteration is normal,
    and same-kind steps repeated in one iteration keep unique ids."""
    host = FakeToolHost(
        {"build_firmware": BUILD_DESC, "flash_firmware": FLASH_DESC},
        results={"build_firmware": {"verdict": "pass", "data": {"stdout": "ok"}}},
    )
    plan = {**VALID_PLAN_ARGS, "checks": []}
    flash_call = ("flash_firmware", {"device_id": "pyocd:0", "firmware_path": "/x.elf"})
    script = [
        make_turn(calls=[("declare_plan", plan)]),
        make_turn(calls=[("build_firmware", {"project_dir": "/proj"})]),
        make_turn(calls=[flash_call]),
        make_turn(calls=[("build_firmware", {"project_dir": "/proj"})]),
        make_turn(calls=[flash_call]),
        make_turn(calls=[("write_report", {"markdown": "# done"})]),
    ]
    engine = make_agent_engine(task_repo, FakeProvider(script), host)
    events = run(drive_to_terminal(engine))
    assert_wire_conformant(events)
    assert events[-1]["type"] == "run.completed"

    # Both flashes were gated: two approvals, each resolving before its flash step.
    approvals = [e for e in events if e["type"] == "approval.requested"]
    assert len(approvals) == 2
    assert len({e["payload"]["approval"]["id"] for e in approvals}) == 2
    assert [name for name, _ in host.invocations] == [
        "build_firmware", "flash_firmware", "build_firmware", "flash_firmware",
    ]

    # Step ids stay unique across repeated same-kind steps (2x build, 2x flash).
    step_ids = [
        e["payload"]["step"]["id"] for e in events if e["type"] == "step.started"
    ]
    assert len(step_ids) == len(set(step_ids))
    kinds = [e["payload"]["step"]["kind"] for e in events if e["type"] == "step.started"]
    assert kinds.count("build") == 2 and kinds.count("flash") == 2


def test_stop_mid_turn_is_a_hard_cancel_and_the_log_stays_sealed(task_repo: Path) -> None:
    async def scenario() -> None:
        provider = HangingProvider()
        engine = make_agent_engine(task_repo, provider)
        engine.start()
        await asyncio.wait_for(provider.entered.wait(), timeout=5)  # mid-turn

        assert engine.stop() is None  # 204: terminal pair emitted immediately
        events = engine.log.events
        assert events[-1]["type"] == "run.stopped"
        assert events[-2]["payload"]["status"] == "stopped"
        assert engine.status == "stopped"

        # The agent task is cancelled at the next await, not "after the turn".
        assert engine.task is not None
        await asyncio.wait_for(asyncio.gather(engine.task, return_exceptions=True), timeout=5)
        assert engine.task.done()

        # Sealed log: nothing is emitted after the terminal event.
        count = len(engine.log.events)
        await asyncio.sleep(0.05)
        assert len(engine.log.events) == count
        assert_wire_conformant(engine.log.events)

    run(scenario())


def test_malformed_meta_tool_gets_one_retry_then_run_fails(task_repo: Path) -> None:
    bad_check = {"requirementId": "build_ok", "verdict": "pass"}  # missing actual + artifactId
    script = [
        make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(calls=[("record_check", bad_check)]),
        make_turn(calls=[("record_check", bad_check)]),
    ]
    engine = make_agent_engine(task_repo, FakeProvider(script))
    events = run(drive_to_terminal(engine))

    assert engine.status == "failed"
    assert events[-1]["type"] == "run.failed"
    assert "record_check" in events[-1]["payload"]["summary"]
    assert not any(e["type"] == "check.evaluated" for e in events)
    # The first rejection told the model why (fail visibly, then one retry).
    error_msgs = [
        m for m in engine._messages
        if m.get("role") == "tool" and "schema_errors" in str(m.get("content"))
    ]
    assert error_msgs, "model was never told why the payload failed"


def test_record_check_enforces_the_evidence_law(task_repo: Path) -> None:
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
    engine = make_agent_engine(task_repo, FakeProvider(script))
    events = run(drive_to_terminal(engine))
    assert events[-1]["type"] == "run.failed"
    assert not any(e["type"] == "check.evaluated" for e in events)


def test_iteration_bound_is_a_harness_counter(task_repo: Path) -> None:
    report = make_turn(calls=[("write_report", {"markdown": "# Partial\nIteration cap."})])
    script = [
        make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(calls=[("declare_iteration", {"reason": "fix attempt 2"})]),
        make_turn(calls=[("declare_iteration", {"reason": "fix attempt 3"})]),  # exceeds cap
    ]
    profile = agent_profile(task_repo, maxIterations=2)
    engine = make_agent_engine(
        task_repo, FakeProvider(script, report_turn=report), profile=profile
    )
    events = run(drive_to_terminal(engine))

    assert events[-1]["type"] == "run.failed"
    assert "iteration bound" in events[-1]["payload"]["summary"]
    assert "partial report attached" in events[-1]["payload"]["summary"]
    iterations = [e for e in events if e["type"] == "run.iteration_started"]
    assert [e["payload"]["iteration"] for e in iterations] == [2]  # 3 never started
    # The partial report artifact exists and precedes the terminal event.
    assert any(
        e["type"] == "artifact.created" and e["payload"]["artifact"]["kind"] == "report_md"
        for e in events
    )


def test_write_report_with_failing_check_ends_honestly_failed(task_repo: Path) -> None:
    script = [
        make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)]),
        make_turn(calls=[("write_file", {"path": "main.c", "content": "x\n", "reason": "edit"})]),
        make_turn(
            calls=[
                (
                    "record_check",
                    {
                        "requirementId": "build_ok",
                        "actual": {"value": "1"},
                        "verdict": "fail",
                        "artifactId": "art_agent1_001_code_diff",
                    },
                )
            ]
        ),
        make_turn(calls=[("write_report", {"markdown": "# Honest failure"})]),
    ]
    engine = make_agent_engine(task_repo, FakeProvider(script))
    events = run(drive_to_terminal(engine))

    assert events[-1]["type"] == "run.failed"
    assert "build_ok" in events[-1]["payload"]["summary"]
    # Evidence retained on failure: the report artifact still exists.
    assert any(
        e["type"] == "artifact.created" and e["payload"]["artifact"]["kind"] == "report_md"
        for e in events
    )


def test_stall_without_tool_calls_fails_closed(task_repo: Path) -> None:
    filler = make_turn(content="thinking out loud, no tools")
    script = [make_turn(calls=[("declare_plan", VALID_PLAN_ARGS)])]
    engine = make_agent_engine(
        task_repo, FakeProvider(script, filler=filler, report_turn=filler), max_turns=10
    )
    events = run(drive_to_terminal(engine))
    assert events[-1]["type"] == "run.failed"
    assert "stalled" in events[-1]["payload"]["summary"]


def test_mcp_transport_error_is_a_visible_step_failure(task_repo: Path) -> None:
    class ExplodingHost(FakeToolHost):
        async def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
            raise RuntimeError("transport torn down")

    host = ExplodingHost({"build_firmware": BUILD_DESC})
    plan = {**VALID_PLAN_ARGS, "checks": []}
    script = [
        make_turn(calls=[("declare_plan", plan)]),
        make_turn(calls=[("build_firmware", {"project_dir": "/proj"})]),
        make_turn(calls=[("write_report", {"markdown": "# done"})]),
    ]
    engine = make_agent_engine(task_repo, FakeProvider(script), host)
    events = run(drive_to_terminal(engine))
    failed_steps = [e for e in events if e["type"] == "step.failed"]
    assert failed_steps and "transport torn down" in failed_steps[0]["payload"]["summary"]
    assert events[-1]["type"] == "run.completed"  # the run itself carried on
