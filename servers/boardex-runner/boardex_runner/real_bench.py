"""Real bench: the scripted pipeline over boardex-target / boardex-logic.

This is the live-hardware counterpart of ``FakeBench``: build with the house
builder, flash through the target registry adapter, stream RTT as the ``rtt``
log stream, capture + decode I2C through the logic registry, and turn the
evidence into MeasurementChecks. It is deliberately scripted (no code editing,
no automatic fix): a failed evaluation diagnoses from the captured evidence
and — having nothing to propose — ends the run in ``run.failed`` (§5.7 rule 4).

Bench methods block on hardware; the engine runs them in an executor
(``blocking = True``), keeping stop/approval handling responsive.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .bench import (
    ApprovalSpec,
    ArtifactSpec,
    CheckSpec,
    DiagnosisSpec,
    LogChunk,
    PlanSpec,
    StepResult,
)
from .contract import CONTRACT_VERSION


@dataclass(frozen=True)
class RealBenchConfig:
    """Everything a scripted live run needs, mirroring the BoardProfile."""

    profile: dict[str, Any]  # the wire BoardProfile entity (§4)
    device_id: str  # target registry id, e.g. "pyocd:stlink:<serial>"
    target: str | None = None  # e.g. "stm32f303retx"
    project_dir: str | None = None
    firmware_path: str | None = None
    build_command: str | None = None
    rtt_pattern: str = r"TEMP=\d+\.\d HUM=\d+\.\d"
    rtt_timeout_s: float = 30.0
    logic_analyzer_id: str | None = None
    i2c_channel_map: dict[str, int] | None = None
    i2c_address_7bit: int | None = None
    sample_rate_hz: int = 4_000_000
    capture_duration_s: float = 2.0
    scl_freq_window_hz: tuple[int, int] = (90_000, 110_000)


@dataclass
class _IterationEvidence:
    firmware_path: str | None = None
    rtt_text: str = ""
    rtt_matched: bool = False
    decode: dict[str, Any] | None = None
    scl_freq_hz: float | None = None
    acked: bool | None = None


class RealBench:
    """Drives the physical bench through the MCP tool layer, in-process."""

    blocking = True

    def __init__(self, config: RealBenchConfig) -> None:
        # Imports are deferred to construction so the runner package imports
        # cleanly on machines without pyOCD/sigrok extras installed.
        from boardex_target import backends as target_backends
        from boardex_target.session import SessionManager

        self.config = config
        self.registry = target_backends.build_registry()
        self.sessions = SessionManager()
        self._session_id: str | None = None
        self._evidence: dict[int, _IterationEvidence] = {}

    # -- helpers -----------------------------------------------------------------

    def _ev(self, iteration: int) -> _IterationEvidence:
        return self._evidence.setdefault(iteration, _IterationEvidence())

    def _adapter(self) -> Any:
        return self.registry.resolve(self.config.device_id)

    # -- bench snapshot -------------------------------------------------------------

    def bench_status(self) -> dict[str, Any]:
        devices: list[dict[str, Any]] = []
        try:
            found = {d.device_id for d in self._adapter().scan()}
        except Exception:
            found = set()
        devices.append(
            {
                "id": self.config.device_id,
                "kind": "debug_probe",
                "name": self.config.profile.get("instruments", {}).get(
                    "debugProbe", self.config.device_id
                ),
                "state": "online" if self.config.device_id in found else "offline",
            }
        )
        serial = self.config.profile.get("serial", {})
        if serial.get("port"):
            devices.append(
                {
                    "id": f"serial:{serial['port']}",
                    "kind": "serial",
                    "name": serial["port"],
                    "state": "online",
                    "detail": f"{serial.get('baud', 115200)} 8N1",
                }
            )
        if self.config.logic_analyzer_id:
            state = "offline"
            try:
                from boardex_logic import backends as logic_backends

                la_found = {
                    d.device_id
                    for d in logic_backends.build_registry()
                    .resolve(self.config.logic_analyzer_id)
                    .scan()
                }
                state = "online" if self.config.logic_analyzer_id in la_found else "offline"
            except Exception:
                pass
            devices.append(
                {
                    "id": self.config.logic_analyzer_id,
                    "kind": "logic_analyzer",
                    "name": self.config.profile.get("instruments", {}).get(
                        "logicAnalyzer", self.config.logic_analyzer_id
                    ),
                    "state": state,
                }
            )
        return {
            "runnerOnline": True,
            "contractVersion": CONTRACT_VERSION,
            "devices": devices,
        }

    # -- plan --------------------------------------------------------------------------

    def plan(self, task_prompt: str, profile: dict[str, Any]) -> PlanSpec:
        with_capture = bool(self.config.logic_analyzer_id and self.config.i2c_channel_map)
        steps = [
            {
                "index": 0,
                "title": "Understand the task and board context",
                "detail": f"Confirm the board profile ({profile.get('name', 'target')}), "
                "firmware source and expected output pattern.",
                "riskLevel": "low",
                "hardwareAction": False,
            },
            {
                "index": 1,
                "title": "Build the firmware",
                "detail": f"Run the profile's build ({self.config.build_command or 'make'}).",
                "riskLevel": "low",
                "hardwareAction": False,
            },
            {
                "index": 2,
                "title": "Flash the firmware",
                "detail": "Program and verify the image via the debug probe, then reset. "
                "Flashing needs approval.",
                "riskLevel": "medium",
                "hardwareAction": True,
            },
            {
                "index": 3,
                "title": "Capture bus and firmware output"
                if with_capture
                else "Read firmware output",
                "detail": (
                    "Decode SCL/SDA with the logic analyzer while streaming RTT."
                    if with_capture
                    else "Stream RTT and wait for the expected output pattern."
                ),
                "riskLevel": "low",
                "hardwareAction": False,
            },
            {
                "index": 4,
                "title": "Validate measurements against the spec",
                "detail": "Evaluate the checks: firmware output pattern"
                + (", SCL frequency window, device ACK" if with_capture else "")
                + ".",
                "riskLevel": "low",
                "hardwareAction": False,
            },
            {
                "index": 5,
                "title": "Produce the evidence-linked report",
                "detail": "Summarize results with every conclusion linked to an artifact.",
                "riskLevel": "low",
                "hardwareAction": False,
            },
        ]
        return PlanSpec(
            steps=steps,
            risk_summary="One medium-risk hardware action: flashing firmware via the "
            "debug probe (requires approval). "
            + str(self.config.profile.get("safety", {}).get("powerNote", "")),
        )

    # -- stages -------------------------------------------------------------------------

    def understand_context(self, iteration: int) -> StepResult | None:
        if iteration != 1:
            return None
        return StepResult(
            ok=True,
            summary="Board profile and firmware source confirmed.",
            logs=[
                LogChunk(
                    "agent",
                    [
                        f"Target: {self.config.target or 'auto'} via {self.config.device_id}.",
                        f"Firmware: {self.config.project_dir or self.config.firmware_path}.",
                        f"Success pattern: {self.config.rtt_pattern!r} on RTT.",
                    ],
                )
            ],
        )

    def edit_code(self, iteration: int) -> StepResult | None:
        return None  # scripted runner: no agent code editing yet

    def build(self, iteration: int) -> StepResult:
        evidence = self._ev(iteration)
        if not self.config.project_dir:
            evidence.firmware_path = self.config.firmware_path
            return StepResult(
                ok=evidence.firmware_path is not None,
                summary=f"Using prebuilt firmware {self.config.firmware_path}.",
            )
        from boardex_target import builder

        result = builder.build_firmware(
            self.config.project_dir, self.config.build_command
        )
        stdout = str(result.data.get("stdout", "") or "")
        evidence.firmware_path = result.data.get("artifact_path")
        return StepResult(
            ok=result.ok,
            summary=result.summary,
            logs=[LogChunk("build", stdout.splitlines() or [result.summary])],
            artifacts=[
                ArtifactSpec(
                    name=f"build_log_iter{iteration}",
                    kind="build_log",
                    label=f"Build log (iteration {iteration})",
                    content=stdout or result.summary,
                )
            ],
        )

    def flash_approval(self, iteration: int) -> ApprovalSpec | None:
        if not self.config.profile.get("safety", {}).get("flashRequiresApproval", True):
            return None
        return ApprovalSpec(
            title="Flash firmware to the target",
            reason="The built image must be programmed to the target before "
            "verification. Board profile marks flashing as approval-required.",
            risk_level="medium",
            files_changed=[],
            hardware_actions=[
                f"Flash {self._ev(iteration).firmware_path} via {self.config.device_id}"
            ],
            status_reason="Flash requires approval (board profile safety)",
        )

    def flash(self, iteration: int) -> StepResult:
        evidence = self._ev(iteration)
        result = self._adapter().flash(
            self.config.device_id,
            str(evidence.firmware_path),
            target=self.config.target,
            verify=True,
            reset_after=True,
        )
        log = json.dumps(dict(result.data), indent=2, default=str)
        return StepResult(
            ok=result.ok,
            summary=result.summary,
            logs=[LogChunk("flash", [result.summary])],
            artifacts=[
                ArtifactSpec(
                    name=f"flash_log_iter{iteration}",
                    kind="flash_log",
                    label=f"Flash log (iteration {iteration})",
                    content=log,
                )
            ],
        )

    def capture(self, iteration: int) -> StepResult | None:
        if not (self.config.logic_analyzer_id and self.config.i2c_channel_map):
            return None
        from boardex_logic import backends as logic_backends

        evidence = self._ev(iteration)
        registry = logic_backends.build_registry()
        analyzer = registry.resolve(self.config.logic_analyzer_id)
        trigger = self.config.i2c_channel_map.get("scl")
        result = analyzer.decode(
            self.config.logic_analyzer_id,
            "i2c",
            self.config.i2c_channel_map,
            sample_rate_hz=self.config.sample_rate_hz,
            duration_s=self.config.capture_duration_s,
            trigger_channel=trigger,
            trigger_edge="falling",
        )
        annotations = list(result.data.get("annotations", []))
        transactions = list(result.data.get("transactions", []))
        decode_content: dict[str, Any] = {
            "protocol": "i2c",
            "device_id": self.config.logic_analyzer_id,
            "channel_map": self.config.i2c_channel_map,
            "sample_rate_hz": self.config.sample_rate_hz,
            "duration_s": self.config.capture_duration_s,
            "bus_state": result.data.get("bus_state", "idle_bus"),
            "annotations": annotations,
            "transactions": transactions,
        }
        evidence.decode = decode_content
        addr = self.config.i2c_address_7bit
        if addr is not None:
            relevant = [tx for tx in transactions if tx.get("addr_7bit") == addr]
            evidence.acked = bool(relevant) and all(
                tx.get("nack_at") != "address" for tx in relevant
            )
        # SCL frequency from annotation timing when the decode provides samples.
        evidence.scl_freq_hz = _estimate_scl_hz(
            annotations, self.config.sample_rate_hz
        )
        artifacts = [
            ArtifactSpec(
                name=f"i2c_decode_iter{iteration}",
                kind="protocol_decode",
                label=f"I2C protocol decode (iteration {iteration})",
                content=decode_content,
            )
        ]
        if evidence.scl_freq_hz is not None:
            artifacts.append(
                ArtifactSpec(
                    name=f"scl_timing_iter{iteration}",
                    kind="timing_measurement",
                    label=f"SCL frequency measurement (iteration {iteration})",
                    content={
                        "measurement": "logic_analyzer.i2c.scl_frequency",
                        "valueHz": int(evidence.scl_freq_hz),
                    },
                )
            )
        return StepResult(
            ok=result.ok,
            summary=result.summary,
            logs=[
                LogChunk(
                    "agent",
                    [
                        f"Decoded {len(transactions)} I2C transaction(s); "
                        f"bus state {decode_content['bus_state']}."
                    ],
                )
            ],
            artifacts=artifacts,
        )

    def read_serial(self, iteration: int) -> StepResult:
        from boardex_target.session import open_session_for, start_session_rtt

        evidence = self._ev(iteration)
        adapter = self._adapter()
        if self._session_id is None:
            managed = open_session_for(
                adapter, self.sessions, self.config.device_id, target=self.config.target
            )
            self._session_id = managed.session_id
        session = self.sessions.get(self._session_id)
        start_session_rtt(session, adapter, elf_path=evidence.firmware_path)
        wait = session.wait_for_rtt(
            self.config.rtt_pattern,
            timeout_s=self.config.rtt_timeout_s,
            regex=True,
            since_last_flash=True,
        )
        text = str(wait.data.get("text", "") or "")
        evidence.rtt_text = text
        evidence.rtt_matched = bool(wait.data.get("matched"))
        lines = text.splitlines() or ["<no RTT output>"]
        # ≤10 Hz log discipline: emit the captured window as batched chunks.
        chunks = [
            LogChunk("rtt", lines[i : i + 20]) for i in range(0, len(lines), 20)
        ]
        return StepResult(
            ok=True,
            summary=(
                "RTT output matched the expected pattern."
                if evidence.rtt_matched
                else "RTT captured; expected pattern not seen."
            ),
            logs=chunks,
            artifacts=[
                ArtifactSpec(
                    name=f"serial_log_iter{iteration}",
                    kind="serial_log",
                    label=f"RTT log (iteration {iteration})",
                    content=text + ("\n" if text and not text.endswith("\n") else ""),
                )
            ],
        )

    def evaluate(self, iteration: int) -> tuple[StepResult, list[CheckSpec]]:
        evidence = self._ev(iteration)
        checks: list[CheckSpec] = [
            CheckSpec(
                requirement_id="firmware_output",
                description="Firmware must stream the expected output pattern",
                measurement="rtt.console.output_pattern",
                expected={"pattern": self.config.rtt_pattern},
                actual={
                    "value": "pattern matched"
                    if evidence.rtt_matched
                    else "pattern not seen before timeout"
                },
                verdict="pass" if evidence.rtt_matched else "fail",
                artifact_name=f"serial_log_iter{iteration}",
            )
        ]
        if evidence.decode is not None:
            lo, hi = self.config.scl_freq_window_hz
            freq = evidence.scl_freq_hz
            checks.append(
                CheckSpec(
                    requirement_id="i2c_clock",
                    description=f"I2C SCL clock must be within {lo}-{hi} Hz",
                    measurement="logic_analyzer.i2c.scl_frequency",
                    expected={"min": lo, "max": hi},
                    actual={"value": int(freq) if freq else 0, "unit": "Hz"},
                    verdict="pass"
                    if freq is not None and lo <= freq <= hi
                    else ("needs_review" if freq is None else "fail"),
                    artifact_name=(
                        f"scl_timing_iter{iteration}"
                        if freq is not None
                        else f"i2c_decode_iter{iteration}"
                    ),
                )
            )
            if self.config.i2c_address_7bit is not None:
                checks.append(
                    CheckSpec(
                        requirement_id="device_ack",
                        description=f"Device must ACK its 7-bit address "
                        f"0x{self.config.i2c_address_7bit:02X}",
                        measurement="logic_analyzer.i2c.device_ack",
                        expected={"equals": True},
                        actual={"value": bool(evidence.acked)},
                        verdict="pass" if evidence.acked else "fail",
                        artifact_name=f"i2c_decode_iter{iteration}",
                    )
                )
        failed = sum(1 for check in checks if check.verdict == "fail")
        summary = (
            f"All {len(checks)} checks pass."
            if failed == 0
            else f"{failed} of {len(checks)} checks failed."
        )
        return StepResult(ok=failed == 0, summary=summary), checks

    def diagnose(
        self, iteration: int, failed: list[dict[str, Any]]
    ) -> tuple[StepResult, DiagnosisSpec]:
        evidence = self._ev(iteration)
        hypotheses: list[dict[str, Any]] = []
        if evidence.decode is not None and evidence.acked is False:
            hypotheses.append(
                {
                    "cause": "Device does not ACK its address: wiring, power or "
                    "address-configuration fault",
                    "evidence": "Protocol decode shows NACK at the address phase.",
                    "confidence": "moderate",
                }
            )
        if not evidence.rtt_matched:
            hypotheses.append(
                {
                    "cause": "Firmware did not reach the expected output state",
                    "evidence": f"RTT window did not match {self.config.rtt_pattern!r}.",
                    "confidence": "moderate",
                }
            )
        if not hypotheses:
            hypotheses.append(
                {
                    "cause": "Unclassified failure",
                    "evidence": "See linked artifacts for the captured evidence.",
                    "confidence": "low",
                }
            )
        step = StepResult(
            ok=True,
            summary="Evidence collected; the scripted runner has no fix to propose.",
            logs=[
                LogChunk(
                    "agent",
                    [f"{len(failed)} failed check(s); no automated fix available."],
                )
            ],
        )
        return step, DiagnosisSpec(
            hypotheses=hypotheses,
            proposed_fix={
                "summary": "No automated fix available; human intervention required.",
                "riskLevel": "low",
                "filesChanged": [],
            },
            fix_approval=None,
        )

    def iteration_reason(self, iteration: int) -> str:
        return "Retrying after an approved fix."

    def report(self, iteration: int) -> StepResult:
        evidence = self._ev(iteration)
        lines = [
            "# Bring-up validation report",
            "",
            f"**Board:** {self.config.profile.get('name', 'target')}",
            f"**Iteration:** {iteration}",
            "",
            "## Evidence",
            f"- RTT pattern matched: {evidence.rtt_matched}",
        ]
        if evidence.scl_freq_hz is not None:
            lines.append(f"- SCL frequency: {int(evidence.scl_freq_hz)} Hz")
        if evidence.acked is not None:
            lines.append(f"- Device ACK: {evidence.acked}")
        return StepResult(
            ok=True,
            summary="Validation report generated.",
            artifacts=[
                ArtifactSpec(
                    name="report",
                    kind="report_md",
                    label="Validation report",
                    content="\n".join(lines) + "\n",
                )
            ],
        )

    def run_summary(self, iteration: int, completed: bool) -> str:
        if completed:
            return f"Bring-up validated on iteration {iteration}; all checks pass."
        return (
            f"Bring-up failed on iteration {iteration}; evidence retained in the "
            "linked artifacts."
        )

    def halt(self) -> None:
        """Hardware-safe stop: stop RTT, close sessions, leave the target sane."""
        try:
            if self._session_id is not None:
                session = self.sessions.get(self._session_id)
                try:
                    session.stop_rtt()
                except Exception:
                    pass
                self.sessions.close(self._session_id)
                self._session_id = None
        except Exception:
            pass


def _estimate_scl_hz(
    annotations: list[dict[str, Any]], sample_rate_hz: int
) -> float | None:
    """Rough SCL frequency from bit-level annotation spans, when present."""
    spans = [
        (a["end"] - a["start"])
        for a in annotations
        if isinstance(a.get("start"), int)
        and isinstance(a.get("end"), int)
        and a["end"] > a["start"]
        and "bit" in str(a.get("text", "")).lower()
    ]
    if not spans:
        return None
    avg_samples_per_bit = sum(spans) / len(spans)
    if avg_samples_per_bit <= 0:
        return None
    return sample_rate_hz / avg_samples_per_bit
