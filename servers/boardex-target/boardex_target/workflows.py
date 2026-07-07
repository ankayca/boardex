"""Composite bring-up workflows for the target MCP server."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from boardex_core import (
    BackendRegistry,
    EvidenceBundle,
    OperationResult,
    SupportsPeripheralInspection,
    TargetController,
    Verdict,
    WorkflowStep,
)

from . import builder
from .integrations import logic as logic_integration
from .session import SessionManager, open_session_for, start_session_rtt


@dataclass(frozen=True)
class CheckpointSpec:
    """Parameters for one build → flash → RTT checkpoint iteration."""

    device_id: str
    rtt_pattern: str
    target: str | None = None
    session_id: str | None = None
    project_dir: str | None = None
    firmware_path: str | None = None
    build_command: str | None = None
    artifact: str | None = None
    clean: bool = False
    rtt_timeout_s: float = 10.0
    inspect_on_failure: str | None = None
    elf_path: str | None = None


@dataclass(frozen=True)
class BringupSpec:
    """Parameters for full bring-up verification (checkpoint + I2C bus proof)."""

    checkpoint: CheckpointSpec
    logic_analyzer_id: str | None = None
    i2c_channel_map: dict[str, int] | None = None
    i2c_expect: list[dict[str, Any]] | None = field(default=None)
    sample_rate_hz: int = 4_000_000
    i2c_duration_s: float = 0.1
    trigger_channel: int | None = None
    trigger_edge: str = "falling"
    reset_before_i2c_capture: bool = True


def _step(name: str, result: OperationResult) -> WorkflowStep:
    return WorkflowStep(
        name=name,
        verdict=result.verdict.value,
        summary=result.summary,
        data=dict(result.data),
    )


def _inspect_on_failure(
    adapter: TargetController,
    device_id: str,
    peripheral: str,
    target: str | None,
    steps: list[WorkflowStep],
    hints: list[str],
) -> dict[str, Any] | None:
    """Inspect ``peripheral`` after a failed checkpoint, collecting evidence."""
    if not isinstance(adapter, SupportsPeripheralInspection):
        return None
    inspect_result = adapter.inspect_peripheral(device_id, peripheral, target=target)
    steps.append(_step("inspect_peripheral", inspect_result))
    if not inspect_result.ok:
        return None
    peripheral_data = dict(inspect_result.data)
    hints.extend(peripheral_data.get("hints", []))
    return peripheral_data


def _run_checkpoint(
    registry: BackendRegistry[TargetController],
    sessions: SessionManager,
    spec: CheckpointSpec,
) -> tuple[OperationResult, list[WorkflowStep]]:
    """Checkpoint core, returning the result plus the live step objects.

    Returning the steps directly (instead of re-parsing them out of the
    serialised evidence) lets ``verify_bringup`` extend the same audit trail.
    """
    adapter = registry.resolve(spec.device_id)
    steps: list[WorkflowStep] = []
    hints: list[str] = []
    image_path = spec.firmware_path

    if spec.project_dir:
        build_result = builder.build_firmware(
            spec.project_dir,
            spec.build_command,
            artifact=spec.artifact,
            clean=spec.clean,
        )
        steps.append(_step("build", build_result))
        if not build_result.ok:
            bundle = EvidenceBundle(
                verdict=build_result.verdict,
                summary=build_result.summary,
                steps=steps,
                hints=hints,
            )
            return (
                OperationResult(
                    build_result.verdict,
                    build_result.summary,
                    data={"evidence": bundle.to_dict(), "artifact_path": None},
                ),
                steps,
            )
        image_path = build_result.data.get("artifact_path")

    if not image_path:
        return (
            OperationResult.errored(
                "Provide firmware_path or project_dir to build from."
            ),
            steps,
        )

    flash_result = adapter.flash(
        spec.device_id,
        image_path,
        target=spec.target,
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
        return (
            OperationResult(
                flash_result.verdict,
                flash_result.summary,
                data={"evidence": bundle.to_dict(), "firmware_path": image_path},
            ),
            steps,
        )

    opened_here = False
    sid = spec.session_id
    if sid is None:
        managed = open_session_for(
            adapter, sessions, spec.device_id, target=spec.target
        )
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

    session = sessions.get(sid)
    rtt_start = start_session_rtt(
        session, adapter, elf_path=spec.elf_path or image_path
    )
    steps.append(_step("start_rtt", rtt_start))
    if not rtt_start.ok and rtt_start.verdict != Verdict.INCONCLUSIVE:
        bundle = EvidenceBundle(
            verdict=rtt_start.verdict,
            summary=rtt_start.summary,
            steps=steps,
        )
        return (
            OperationResult(
                rtt_start.verdict,
                rtt_start.summary,
                data={"evidence": bundle.to_dict(), "session_id": sid},
            ),
            steps,
        )

    wait_result = session.wait_for_rtt(
        spec.rtt_pattern, timeout_s=spec.rtt_timeout_s, since_last_flash=True
    )
    steps.append(_step("wait_for_rtt", wait_result))

    peripheral_data: dict[str, Any] | None = None
    if not wait_result.data.get("matched") and spec.inspect_on_failure:
        peripheral_data = _inspect_on_failure(
            adapter, spec.device_id, spec.inspect_on_failure, spec.target, steps, hints
        )

    rtt_data = {
        "matched": wait_result.data.get("matched"),
        "pattern": spec.rtt_pattern,
        "text": wait_result.data.get("text"),
        "timed_out": wait_result.data.get("timed_out"),
    }

    verdict = Verdict.PASS if wait_result.data.get("matched") else Verdict.FAIL
    summary = (
        f"Checkpoint {'passed' if verdict == Verdict.PASS else 'failed'}: "
        f"RTT pattern {spec.rtt_pattern!r}."
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
    return result, steps


def run_checkpoint(
    registry: BackendRegistry[TargetController],
    sessions: SessionManager,
    spec: CheckpointSpec,
) -> OperationResult:
    """Build (optional), flash, wait for RTT, optionally inspect on failure."""
    result, _steps = _run_checkpoint(registry, sessions, spec)
    return result


def verify_bringup(
    registry: BackendRegistry[TargetController],
    sessions: SessionManager,
    spec: BringupSpec,
) -> OperationResult:
    """Full sensor bring-up: build, flash, RTT proof, optional I2C bus proof."""
    cp = spec.checkpoint
    # Peripheral inspection is deferred to this level so its evidence lands in
    # the final bundle exactly once.
    checkpoint, steps = _run_checkpoint(
        registry, sessions, replace(cp, inspect_on_failure=None)
    )
    sid = checkpoint.data.get("session_id")
    hints: list[str] = list(checkpoint.data.get("evidence", {}).get("hints", []))
    rtt_data = checkpoint.data.get("evidence", {}).get("rtt")
    peripheral_data = checkpoint.data.get("evidence", {}).get("peripheral")
    i2c_data: dict[str, Any] | None = None

    adapter = registry.resolve(cp.device_id)

    if spec.logic_analyzer_id and spec.i2c_channel_map:
        la = logic_integration.resolve_logic_analyzer(spec.logic_analyzer_id)
        if la is None:
            err = OperationResult.errored(
                "boardex-logic is not installed or logic analyzer id is unknown.",
                logic_analyzer_id=spec.logic_analyzer_id,
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

        if spec.reset_before_i2c_capture and sid:
            reset_result = adapter.reset(cp.device_id, target=cp.target, halt=False)
            steps.append(_step("reset_before_capture", reset_result))

        trig = spec.trigger_channel
        if trig is None and "scl" in spec.i2c_channel_map:
            trig = spec.i2c_channel_map["scl"]

        decode_result = la.decode(
            spec.logic_analyzer_id,
            "i2c",
            spec.i2c_channel_map,
            sample_rate_hz=spec.sample_rate_hz,
            duration_s=spec.i2c_duration_s,
            trigger_channel=trig,
            trigger_edge=spec.trigger_edge,
        )
        steps.append(_step("decode_bus", decode_result))

        i2c_data = {
            "bus_state": decode_result.data.get("bus_state"),
            "transactions": decode_result.data.get("transactions", []),
            "annotations": decode_result.data.get("annotations", []),
            "trigger_channel": trig,
            "trigger_edge": spec.trigger_edge if trig is not None else None,
        }

        if spec.i2c_expect:
            match = logic_integration.match_i2c_expectations(
                decode_result.data.get("transactions", []), spec.i2c_expect
            )
            if match is not None:
                i2c_data["expectations"] = match
                if not match["matched"]:
                    hints.extend(match.get("failures", []))

    rtt_ok = bool(rtt_data and rtt_data.get("matched"))
    i2c_ok = True
    if spec.i2c_channel_map and spec.logic_analyzer_id:
        if spec.i2c_expect:
            i2c_ok = bool(i2c_data and i2c_data.get("expectations", {}).get("matched"))
        elif i2c_data:
            i2c_ok = i2c_data.get("bus_state") == "decoded_ok"
        else:
            i2c_ok = False

    if not rtt_ok and cp.inspect_on_failure and peripheral_data is None:
        peripheral_data = _inspect_on_failure(
            adapter, cp.device_id, cp.inspect_on_failure, cp.target, steps, hints
        )

    if spec.i2c_channel_map and spec.logic_analyzer_id and i2c_data and not i2c_ok:
        if i2c_data.get("bus_state") == "idle_bus":
            hints.append("Logic analyzer saw no I2C activity (idle bus).")

    verdict = checkpoint.verdict
    if spec.i2c_channel_map and spec.logic_analyzer_id and not i2c_ok:
        verdict = Verdict.FAIL

    parts = []
    parts.append("RTT pass" if rtt_ok else "RTT fail")
    if spec.i2c_channel_map:
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
