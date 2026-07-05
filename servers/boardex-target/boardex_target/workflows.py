"""Composite bring-up workflows for the target MCP server."""

from __future__ import annotations

from typing import Any

from boardex_core import (
    BackendRegistry,
    EvidenceBundle,
    OperationResult,
    TargetController,
    Verdict,
    WorkflowStep,
)

from . import builder
from .integrations import logic as logic_integration
from .session import SessionManager


def _step(name: str, result: OperationResult) -> WorkflowStep:
    return WorkflowStep(
        name=name,
        verdict=result.verdict.value,
        summary=result.summary,
        data=dict(result.data),
    )


def _ensure_rtt(
    sessions: SessionManager,
    session_id: str,
    adapter: TargetController,
    *,
    elf_path: str | None,
) -> OperationResult:
    session = sessions.get(session_id)
    info = session.info()
    if info.get("rtt_running"):
        return OperationResult.passed("RTT logging already running.", channel=info.get("rtt_channel"))
    address = None
    resolver = getattr(adapter, "rtt_control_block", None)
    if resolver is not None:
        address = resolver(session.device_id, elf_path)
    return session.start_rtt(control_block_address=address)


def run_checkpoint(
    registry: BackendRegistry[TargetController],
    sessions: SessionManager,
    *,
    device_id: str,
    target: str | None,
    session_id: str | None,
    project_dir: str | None,
    firmware_path: str | None,
    build_command: str | None,
    artifact: str | None,
    clean: bool,
    rtt_pattern: str,
    rtt_timeout_s: float,
    inspect_on_failure: str | None,
    elf_path: str | None,
) -> OperationResult:
    """Build (optional), flash, wait for RTT, optionally inspect on failure."""
    adapter = registry.resolve(device_id)
    steps: list[WorkflowStep] = []
    hints: list[str] = []
    image_path = firmware_path

    if project_dir:
        build_result = builder.build_firmware(
            project_dir,
            build_command,
            artifact=artifact,
            clean=clean,
        )
        steps.append(_step("build", build_result))
        if not build_result.ok:
            bundle = EvidenceBundle(
                verdict=build_result.verdict,
                summary=build_result.summary,
                steps=steps,
                hints=hints,
            )
            return OperationResult(
                build_result.verdict,
                build_result.summary,
                data={"evidence": bundle.to_dict(), "artifact_path": None},
            )
        image_path = build_result.data.get("artifact_path")

    if not image_path:
        return OperationResult.errored(
            "Provide firmware_path or project_dir to build from."
        )

    flash_result = adapter.flash(
        device_id,
        image_path,
        target=target,
        verify=True,
        reset_after=True,
    )
    steps.append(_step("flash", flash_result))
    if not flash_result.ok:
        bundle = EvidenceBundle(
            verdict=flash_result.verdict,
            summary=flash_result.summary,
            steps=steps,
        )
        return OperationResult(
            flash_result.verdict,
            flash_result.summary,
            data={"evidence": bundle.to_dict(), "firmware_path": image_path},
        )

    opened_here = False
    sid = session_id
    if sid is None:
        uid = adapter.probe_unique_id(device_id)  # type: ignore[attr-defined]
        managed = sessions.open(device_id, uid, target=target)
        sid = managed.session_id
        opened_here = True
        steps.append(
            WorkflowStep(
                "open_session",
                Verdict.PASS.value,
                f"Opened session {sid}.",
                {"session_id": sid},
            )
        )

    rtt_start = _ensure_rtt(sessions, sid, adapter, elf_path=elf_path or image_path)
    steps.append(_step("start_rtt", rtt_start))
    if not rtt_start.ok and rtt_start.verdict != Verdict.INCONCLUSIVE:
        bundle = EvidenceBundle(
            verdict=rtt_start.verdict,
            summary=rtt_start.summary,
            steps=steps,
        )
        return OperationResult(
            rtt_start.verdict,
            rtt_start.summary,
            data={"evidence": bundle.to_dict(), "session_id": sid},
        )

    wait_result = sessions.get(sid).wait_for_rtt(
        rtt_pattern, timeout_s=rtt_timeout_s, since_last_flash=True
    )
    steps.append(_step("wait_for_rtt", wait_result))

    peripheral_data: dict[str, Any] | None = None
    if not wait_result.data.get("matched") and inspect_on_failure:
        inspect_fn = getattr(adapter, "inspect_peripheral", None)
        if inspect_fn is not None:
            inspect_result = inspect_fn(
                device_id, inspect_on_failure, target=target
            )
            steps.append(_step("inspect_peripheral", inspect_result))
            if inspect_result.ok:
                peripheral_data = dict(inspect_result.data)
                hints.extend(peripheral_data.get("hints", []))

    rtt_data = {
        "matched": wait_result.data.get("matched"),
        "pattern": rtt_pattern,
        "text": wait_result.data.get("text"),
        "timed_out": wait_result.data.get("timed_out"),
    }

    verdict = Verdict.PASS if wait_result.data.get("matched") else Verdict.FAIL
    summary = (
        f"Checkpoint {'passed' if verdict == Verdict.PASS else 'failed'}: "
        f"RTT pattern {rtt_pattern!r}."
    )
    bundle = EvidenceBundle(
        verdict=verdict,
        summary=summary,
        rtt=rtt_data,
        peripheral=peripheral_data,
        hints=hints,
        steps=steps,
    )
    data: dict[str, Any] = {
        "evidence": bundle.to_dict(),
        "session_id": sid,
        "firmware_path": image_path,
        "session_opened": opened_here,
    }
    result = OperationResult(verdict, summary, data=data)
    result.duration_s = wait_result.duration_s
    return result


def verify_bringup(
    registry: BackendRegistry[TargetController],
    sessions: SessionManager,
    *,
    target_device_id: str,
    logic_analyzer_id: str | None,
    target: str | None,
    session_id: str | None,
    project_dir: str | None,
    firmware_path: str | None,
    build_command: str | None,
    artifact: str | None,
    clean: bool,
    rtt_pattern: str,
    rtt_timeout_s: float,
    i2c_channel_map: dict[str, int] | None,
    i2c_expect: list[dict[str, Any]] | None,
    sample_rate_hz: int,
    i2c_duration_s: float,
    trigger_channel: int | None,
    trigger_edge: str,
    reset_before_i2c_capture: bool,
    inspect_on_failure: str | None,
    elf_path: str | None,
) -> OperationResult:
    """Full sensor bring-up: build, flash, RTT proof, optional I2C bus proof."""
    checkpoint = run_checkpoint(
        registry,
        sessions,
        device_id=target_device_id,
        target=target,
        session_id=session_id,
        project_dir=project_dir,
        firmware_path=firmware_path,
        build_command=build_command,
        artifact=artifact,
        clean=clean,
        rtt_pattern=rtt_pattern,
        rtt_timeout_s=rtt_timeout_s,
        inspect_on_failure=None,
        elf_path=elf_path,
    )
    steps = [
        WorkflowStep(
            name=s["name"],
            verdict=s["verdict"],
            summary=s["summary"],
            data=s.get("data", {}),
        )
        for s in checkpoint.data.get("evidence", {}).get("steps", [])
    ]
    sid = checkpoint.data.get("session_id")
    hints: list[str] = list(checkpoint.data.get("evidence", {}).get("hints", []))
    rtt_data = checkpoint.data.get("evidence", {}).get("rtt")
    peripheral_data = checkpoint.data.get("evidence", {}).get("peripheral")
    i2c_data: dict[str, Any] | None = None

    adapter = registry.resolve(target_device_id)

    if logic_analyzer_id and i2c_channel_map:
        la = logic_integration.resolve_logic_analyzer(logic_analyzer_id)
        if la is None:
            err = OperationResult.errored(
                "boardex-logic is not installed or logic analyzer id is unknown.",
                logic_analyzer_id=logic_analyzer_id,
            )
            steps.append(_step("decode_bus", err))
            bundle = EvidenceBundle(
                verdict=Verdict.ERROR,
                summary=err.summary,
                rtt=rtt_data,
                i2c=None,
                peripheral=peripheral_data,
                hints=hints,
                steps=steps,
            )
            return OperationResult(
                Verdict.ERROR,
                err.summary,
                data={"evidence": bundle.to_dict(), "session_id": sid},
            )

        if reset_before_i2c_capture and sid:
            reset_result = adapter.reset(target_device_id, target=target, halt=False)
            steps.append(_step("reset_before_capture", reset_result))

        trig = trigger_channel
        if trig is None and "scl" in i2c_channel_map:
            trig = i2c_channel_map["scl"]

        decode_result = la.decode(
            logic_analyzer_id,
            "i2c",
            i2c_channel_map,
            sample_rate_hz=sample_rate_hz,
            duration_s=i2c_duration_s,
            trigger_channel=trig,
            trigger_edge=trigger_edge,
        )
        steps.append(_step("decode_bus", decode_result))

        i2c_data = {
            "bus_state": decode_result.data.get("bus_state"),
            "transactions": decode_result.data.get("transactions", []),
            "annotations": decode_result.data.get("annotations", []),
            "trigger_channel": trig,
            "trigger_edge": trigger_edge if trig is not None else None,
        }

        if i2c_expect:
            from boardex_logic.decode.i2c import match_expectations

            match = match_expectations(
                decode_result.data.get("transactions", []), i2c_expect
            )
            i2c_data["expectations"] = match
            if not match["matched"]:
                hints.extend(match.get("failures", []))

    rtt_ok = bool(rtt_data and rtt_data.get("matched"))
    i2c_ok = True
    if i2c_channel_map and logic_analyzer_id:
        if i2c_expect:
            i2c_ok = bool(i2c_data and i2c_data.get("expectations", {}).get("matched"))
        elif i2c_data:
            i2c_ok = i2c_data.get("bus_state") == "decoded_ok"
        else:
            i2c_ok = False

    if not rtt_ok and inspect_on_failure and peripheral_data is None:
        inspect_fn = getattr(adapter, "inspect_peripheral", None)
        if inspect_fn is not None:
            inspect_result = inspect_fn(
                target_device_id, inspect_on_failure, target=target
            )
            steps.append(_step("inspect_peripheral", inspect_result))
            if inspect_result.ok:
                peripheral_data = dict(inspect_result.data)
                hints.extend(peripheral_data.get("hints", []))

    if i2c_channel_map and logic_analyzer_id and i2c_data and not i2c_ok:
        if i2c_data.get("bus_state") == "idle_bus":
            hints.append("Logic analyzer saw no I2C activity (idle bus).")

    verdict = checkpoint.verdict
    if i2c_channel_map and logic_analyzer_id and not i2c_ok:
        verdict = Verdict.FAIL

    parts = []
    parts.append("RTT pass" if rtt_ok else "RTT fail")
    if i2c_channel_map:
        parts.append("I2C pass" if i2c_ok else "I2C fail")
    summary = f"Bring-up verification: {', '.join(parts)}."

    bundle = EvidenceBundle(
        verdict=verdict,
        summary=summary,
        rtt=rtt_data,
        i2c=i2c_data,
        peripheral=peripheral_data,
        hints=hints,
        steps=steps,
    )
    return OperationResult(
        verdict,
        summary,
        data={
            "evidence": bundle.to_dict(),
            "session_id": sid,
            "firmware_path": checkpoint.data.get("firmware_path"),
        },
    )
