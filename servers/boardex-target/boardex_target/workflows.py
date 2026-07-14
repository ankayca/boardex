"""Composite bring-up workflows for the target MCP server."""

from __future__ import annotations

import concurrent.futures
import threading
import time
from dataclasses import dataclass, field, replace
from typing import Any

from boardex_core import (
    BackendRegistry,
    EvidenceBundle,
    OperationResult,
    SupportsCoordinatedCapture,
    SupportsPeripheralInspection,
    TargetController,
    Verdict,
    WorkflowStep,
)

from . import builder
from .integrations import logic as logic_integration
from .session import SessionManager, open_session_for, start_session_rtt

CAPTURE_ARM_DELAY_S = 0.25


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


def reset_and_capture_i2c(
    registry: BackendRegistry[TargetController],
    *,
    device_id: str,
    logic_analyzer_id: str,
    channel_map: dict[str, int],
    target: str | None = None,
    sample_rate_hz: int = 4_000_000,
    duration_s: float = 0.1,
    trigger_channel: int | None = None,
    trigger_edge: str = "falling",
    options: dict[str, str] | None = None,
    arm_delay_s: float = CAPTURE_ARM_DELAY_S,
    sessions: SessionManager | None = None,
) -> OperationResult:
    """Capture immediate post-reset I2C traffic without a reset/arm race.

    The target is first held at reset, then the trigger-armed analyzer is
    started on a worker. Only after that worker has entered the decode call and
    had a short hardware-arm interval do we resume the MCU.
    """
    adapter = registry.resolve(device_id)
    managed = sessions.find_by_device(device_id) if sessions is not None else None
    if sessions is not None and managed is None:
        managed = open_session_for(adapter, sessions, device_id, target=target)
    analyzer = logic_integration.resolve_logic_analyzer(logic_analyzer_id)
    if analyzer is None:
        return OperationResult.errored(
            "boardex-logic is not installed or logic analyzer id is unknown.",
            logic_analyzer_id=logic_analyzer_id,
        )

    reset_result = adapter.reset(device_id, target=target, halt=True)
    if not reset_result.ok:
        return OperationResult(
            reset_result.verdict,
            f"Could not halt target before capture: {reset_result.summary}",
            data={"reset": reset_result.to_dict()},
        )

    trig = trigger_channel
    if trig is None and "scl" in channel_map:
        trig = channel_map["scl"]

    if isinstance(analyzer, SupportsCoordinatedCapture):
        decode_result, resume_result = _coordinated_capture(
            adapter,
            analyzer,
            device_id=device_id,
            logic_analyzer_id=logic_analyzer_id,
            channel_map=channel_map,
            target=target,
            sample_rate_hz=sample_rate_hz,
            duration_s=duration_s,
            trig=trig,
            trigger_edge=trigger_edge,
            options=options,
        )
    else:
        decode_result, resume_result = _delayed_arm_capture(
            adapter,
            analyzer,
            device_id=device_id,
            logic_analyzer_id=logic_analyzer_id,
            channel_map=channel_map,
            target=target,
            sample_rate_hz=sample_rate_hz,
            duration_s=duration_s,
            trig=trig,
            trigger_edge=trigger_edge,
            options=options,
            arm_delay_s=arm_delay_s,
        )

    if resume_result is not None and not resume_result.ok:
        return OperationResult(
            resume_result.verdict,
            f"Analyzer armed but target could not resume: {resume_result.summary}",
            data={
                "reset": reset_result.to_dict(),
                "resume": resume_result.to_dict(),
            },
        )
    if decode_result is None:
        return OperationResult.errored(
            "Logic-analyzer capture worker did not start; target resumed."
        )

    decode_result.data["capture_coordination"] = {
        "target_reset_halted": True,
        "analyzer_armed_before_resume": True,
        "resume_gated_on": (
            "acquisition_marker"
            if isinstance(analyzer, SupportsCoordinatedCapture)
            and decode_result.data.get("armed_via_marker")
            else "arm_delay"
        ),
        "session_id": managed.session_id if managed is not None else None,
    }
    return decode_result


def _coordinated_capture(
    adapter: TargetController,
    analyzer: SupportsCoordinatedCapture,
    *,
    device_id: str,
    logic_analyzer_id: str,
    channel_map: dict[str, int],
    target: str | None,
    sample_rate_hz: int,
    duration_s: float,
    trig: int | None,
    trigger_edge: str,
    options: dict[str, str] | None,
) -> tuple[OperationResult | None, OperationResult | None]:
    """Resume the target the instant the analyzer confirms it is sampling.

    Removes the fixed arm-delay guess: ``on_started`` fires (and resumes the
    MCU) only once acquisition is physically live, so a startup-only chip-ID
    read cannot slip through before the window opens.
    """
    resume_holder: dict[str, OperationResult] = {}
    resumed = threading.Event()

    def on_started() -> None:
        if resumed.is_set():
            return
        resume_holder["result"] = adapter.resume(device_id, target=target)
        resumed.set()

    try:
        decode_result = analyzer.decode_coordinated(
            logic_analyzer_id,
            "i2c",
            channel_map,
            on_capture_started=on_started,
            sample_rate_hz=sample_rate_hz,
            duration_s=duration_s,
            options=options,
            trigger_channel=trig,
            trigger_edge=trigger_edge,
        )
    finally:
        # Belt and suspenders: never leave a halted target, whether the analyzer
        # returned without signalling or blew up before arming.
        if not resumed.is_set():
            resume_holder["result"] = adapter.resume(device_id, target=target)
            resumed.set()
    return decode_result, resume_holder.get("result")


def _delayed_arm_capture(
    adapter: TargetController,
    analyzer: Any,
    *,
    device_id: str,
    logic_analyzer_id: str,
    channel_map: dict[str, int],
    target: str | None,
    sample_rate_hz: int,
    duration_s: float,
    trig: int | None,
    trigger_edge: str,
    options: dict[str, str] | None,
    arm_delay_s: float,
) -> tuple[OperationResult | None, OperationResult | None]:
    """Fallback for analyzers that cannot report acquisition start.

    Starts the capture on a worker, waits a fixed arm interval, then resumes —
    the best a backend without ``SupportsCoordinatedCapture`` can do.
    """
    decode_entered = threading.Event()

    def capture() -> OperationResult:
        decode_entered.set()
        return analyzer.decode(
            logic_analyzer_id,
            "i2c",
            channel_map,
            sample_rate_hz=sample_rate_hz,
            duration_s=duration_s,
            options=options,
            trigger_channel=trig,
            trigger_edge=trigger_edge,
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(capture)
        if not decode_entered.wait(timeout=1.0):
            adapter.resume(device_id, target=target)
            return None, None
        time.sleep(max(0.0, arm_delay_s))
        resume_result = adapter.resume(device_id, target=target)
        # Always collect the analyzer result so its subprocess cannot outlive
        # the workflow and keep the USB device claimed.
        decode_result = future.result()
    return decode_result, resume_result


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

        trig = spec.trigger_channel
        if trig is None and "scl" in spec.i2c_channel_map:
            trig = spec.i2c_channel_map["scl"]

        if spec.reset_before_i2c_capture:
            decode_result = reset_and_capture_i2c(
                registry,
                device_id=cp.device_id,
                target=cp.target,
                logic_analyzer_id=spec.logic_analyzer_id,
                channel_map=spec.i2c_channel_map,
                sample_rate_hz=spec.sample_rate_hz,
                duration_s=spec.i2c_duration_s,
                trigger_channel=trig,
                trigger_edge=spec.trigger_edge,
                sessions=sessions,
            )
        else:
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
            "protocol": decode_result.data.get("protocol", "i2c"),
            "device_id": decode_result.data.get("device_id", spec.logic_analyzer_id),
            "channel_map": decode_result.data.get("channel_map", spec.i2c_channel_map),
            "sample_rate_hz": decode_result.data.get("sample_rate_hz", spec.sample_rate_hz),
            "num_samples": decode_result.data.get("num_samples"),
            "duration_s": decode_result.data.get("duration_s", spec.i2c_duration_s),
            "bus_state": decode_result.data.get("bus_state"),
            "scl_frequency_hz": decode_result.data.get("scl_frequency_hz"),
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
