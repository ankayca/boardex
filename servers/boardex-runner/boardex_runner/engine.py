"""The scripted run engine: BIBLE §5.7 state machine over a Bench.

One ``RunEngine`` owns one run: its event log (gapless seq), its artifact
namespace, its approval gates and its pipeline task. Commands arrive from the
HTTP layer on the event loop thread; blocking bench work runs in an executor,
so a stop or approval is never queued behind hardware.

Non-negotiables implemented here (BIBLE §10.2):
- approvals block: no bench call happens while a gate is pending;
- stop is fast: the HTTP handler itself emits the terminal events and seals
  the log — the pipeline task then unwinds on ``RunTerminated``;
- every MeasurementCheck's artifactId resolves before check.evaluated is
  emitted (evidence-linking law).
"""

from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass
from typing import Any, Callable

from .artifacts import ArtifactStore
from .bench import ApprovalSpec, Bench, CheckSpec, StepResult
from .clock import Clock
from .contract import STATUS_TRANSITIONS, ContractViolation
from .events import EventLog, RunTerminated


@dataclass(frozen=True)
class Conflict:
    """Maps to HTTP 409 { error, currentStatus } (§5.3)."""

    error: str
    current_status: str


@dataclass
class _Gate:
    kind: str  # 'plan' | 'approval'
    approval_id: str | None
    future: "asyncio.Future[str]"  # resolves to 'approved' | 'rejected'


def new_run_id() -> str:
    return f"run_{secrets.token_hex(6)}"


def _title_from_prompt(task_prompt: str) -> str:
    text = " ".join(task_prompt.split())
    first = text.split(". ")[0].strip().rstrip(".")
    return (first[:77] + "...") if len(first) > 80 else (first or "Run")


class RunEngine:
    """One run: event log + status + gates + the pipeline task."""

    def __init__(
        self,
        *,
        run_id: str,
        task_prompt: str,
        profile: dict[str, Any],
        bench: Bench,
        clock: Clock,
        artifacts: ArtifactStore,
        on_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.id = run_id
        self.task_prompt = task_prompt
        self.profile = profile
        self.bench = bench
        self.clock = clock
        self.artifacts = artifacts
        self.log = EventLog(run_id, on_event=on_event)

        self.title = _title_from_prompt(task_prompt)
        self.status = "draft"
        self.created_at = clock.now_iso()
        self.updated_at = self.created_at
        self.iteration = 1
        self._gate: _Gate | None = None
        self._artifact_ids: dict[str, str] = {}  # bench name -> wire artifact id
        self._suffix = run_id.rsplit("_", 1)[-1][:6]
        self.task: asyncio.Task[None] | None = None

    # -- public: server-facing --------------------------------------------------

    def start(self) -> None:
        if self.task is None:
            self.task = asyncio.get_running_loop().create_task(self._execute())

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "boardProfileId": str(self.profile["id"]),
            "updatedAt": self.updated_at,
        }

    def events_after(self, after_seq: int) -> list[dict[str, Any]]:
        return self.log.after(after_seq)

    def approve_plan(self) -> Conflict | None:
        if self._gate is None or self._gate.kind != "plan":
            return Conflict("run is not awaiting plan approval", self.status)
        self._release_gate("approved")
        return None

    def resolve_approval(self, approval_id: str, status: str) -> Conflict | None:
        gate = self._gate
        if gate is None or gate.kind != "approval" or gate.approval_id != approval_id:
            return Conflict(
                f'approval "{approval_id}" is not awaiting resolution', self.status
            )
        self._release_gate(status)
        return None

    def stop(self) -> Conflict | None:
        """POST /runs/{id}/stop — emits the terminal pair immediately (§10.2.3)."""
        if self.log.sealed:
            return Conflict("run has already reached a terminal state", self.status)
        # A stop can beat run.created; a known-typed stream must still open with
        # the run it stops (mirrors the mock, T5.0 FIX_FIRST F1).
        if not self.log.has_type("run.created"):
            self._emit("run.created", {"run": self._run_entity("planning")})
        self._emit(
            "run.status_changed", {"status": "stopped", "reason": "Stopped by user"}
        )
        self.status = "stopped"
        self._emit("run.stopped", {"byUser": True})
        self._cancel_gate()
        self._halt_bench_soon()
        return None

    def dispose(self) -> None:
        if self.task is not None and not self.task.done():
            self.task.cancel()
        self._cancel_gate()

    # -- internals ----------------------------------------------------------------

    def _emit(self, type_: str, payload: dict[str, Any]) -> dict[str, Any]:
        event = self.log.append(type_, payload, self.clock.now_iso())
        self.updated_at = event["ts"]
        return event

    def _transition(self, status: str, reason: str) -> None:
        allowed = STATUS_TRANSITIONS.get(self.status, frozenset())
        if status not in allowed:
            raise ContractViolation(
                f"illegal status transition {self.status} -> {status} (§5.7)"
            )
        self._emit("run.status_changed", {"status": status, "reason": reason})
        self.status = status

    def _run_entity(self, status: str) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "taskPrompt": self.task_prompt,
            "boardProfileId": str(self.profile["id"]),
            "status": status,
            "createdAt": self.created_at,
            "updatedAt": self.clock.now_iso(),
            "iteration": self.iteration,
        }

    async def _sleep(self, ms: float) -> None:
        await self.clock.sleep(ms)
        if self.log.sealed:
            raise RunTerminated(self.id)

    async def _call(self, fn: Callable[..., Any], *args: Any) -> Any:
        if self.bench.blocking:
            return await asyncio.get_running_loop().run_in_executor(None, fn, *args)
        return fn(*args)

    def _halt_bench_soon(self) -> None:
        """Hardware-safe halt without blocking the HTTP response."""

        def _halt() -> None:
            try:
                self.bench.halt()
            except Exception:  # halt is best-effort; the log is already sealed
                pass

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            _halt()
            return
        if self.bench.blocking:
            loop.run_in_executor(None, _halt)
        else:
            loop.call_soon(_halt)

    # -- gates ---------------------------------------------------------------------

    async def _wait_gate(self, kind: str, approval_id: str | None = None) -> str:
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._gate = _Gate(kind=kind, approval_id=approval_id, future=future)
        try:
            outcome = await future
        finally:
            self._gate = None
        if self.log.sealed:
            raise RunTerminated(self.id)
        return outcome

    def _release_gate(self, outcome: str) -> None:
        gate = self._gate
        if gate is not None and not gate.future.done():
            gate.future.set_result(outcome)

    def _cancel_gate(self) -> None:
        gate = self._gate
        if gate is not None and not gate.future.done():
            gate.future.set_result("rejected")

    async def _approval_gate(self, spec: ApprovalSpec) -> bool:
        """Pause on an approval. Returns True if approved, False if the run
        ended (rejected -> stopped). No bench call happens while pending."""
        approval_id = f"apr_{self._suffix}_{self.log.next_seq}"
        self._transition("awaiting_approval", spec.status_reason)
        self._emit(
            "approval.requested",
            {
                "approval": {
                    "id": approval_id,
                    "runId": self.id,
                    "proposal": {
                        "title": spec.title,
                        "reason": spec.reason,
                        "riskLevel": spec.risk_level,
                        "filesChanged": spec.files_changed,
                        "hardwareActions": spec.hardware_actions,
                    },
                    "status": "pending",
                }
            },
        )
        outcome = await self._wait_gate("approval", approval_id)
        self._emit(
            "approval.resolved",
            {
                "approvalId": approval_id,
                "status": outcome,
                "resolvedAt": self.clock.now_iso(),
            },
        )
        if outcome == "rejected":
            self._emit(
                "run.status_changed",
                {"status": "stopped", "reason": "Approval rejected"},
            )
            self.status = "stopped"
            self._emit("run.stopped", {"byUser": True})
            self._halt_bench_soon()
            return False
        return True

    # -- steps ------------------------------------------------------------------------

    async def _run_step(self, kind: str, plan_index: int, title: str, result: StepResult) -> str:
        """Emit the step lifecycle for a completed bench stage; returns stepId."""
        await self._sleep(result.delay_ms)
        step_id = f"st_{kind}_iter{self.iteration}_{self._suffix}"
        if kind == "report":
            step_id = f"st_report_{self._suffix}"
        self._emit(
            "step.started",
            {
                "step": {
                    "id": step_id,
                    "runId": self.id,
                    "planIndex": plan_index,
                    "kind": kind,
                    "status": "active",
                    "title": title,
                    "startedAt": self.clock.now_iso(),
                    "artifactIds": [],
                }
            },
        )
        for chunk in result.logs:
            await self._sleep(chunk.delay_ms)
            self._emit(
                "step.log",
                {"stepId": step_id, "stream": chunk.stream, "lines": chunk.lines},
            )
        artifact_ids: list[str] = []
        for spec in result.artifacts:
            artifact_id = f"art_{self._suffix}_{spec.name}"
            meta = self.artifacts.put(
                artifact_id=artifact_id,
                run_id=self.id,
                step_id=step_id,
                kind=spec.kind,
                label=spec.label,
                content=spec.content,
                mime_type=spec.mime_type,
            )
            self._artifact_ids[spec.name] = artifact_id
            artifact_ids.append(artifact_id)
            self._emit("artifact.created", {"artifact": meta})
        self._emit(
            "step.completed" if result.ok else "step.failed",
            {"stepId": step_id, "summary": result.summary, "artifactIds": artifact_ids},
        )
        return step_id

    def _emit_check(self, check: CheckSpec) -> dict[str, Any]:
        artifact_id = self._artifact_ids.get(check.artifact_name)
        if artifact_id is None or artifact_id not in self.artifacts:
            raise ContractViolation(
                f"check {check.requirement_id!r} cites artifact "
                f"{check.artifact_name!r} which does not resolve (evidence law)"
            )
        entity: dict[str, Any] = {
            "id": f"chk_{check.requirement_id}",
            "runId": self.id,
            "requirementId": check.requirement_id,
            "description": check.description,
            "measurement": check.measurement,
            "expected": check.expected,
            "actual": check.actual,
            "verdict": check.verdict,
            "artifactId": artifact_id,
        }
        if check.source_ref is not None:
            entity["sourceRef"] = check.source_ref
        self._emit("check.evaluated", {"check": entity})
        return entity

    # -- the pipeline ------------------------------------------------------------------

    async def _execute(self) -> None:
        try:
            await self._pipeline()
        except (RunTerminated, asyncio.CancelledError):
            pass
        except Exception as error:  # never die silently: the UI must see failure
            if not self.log.sealed:
                try:
                    self._emit("run.failed", {"summary": f"Runner error: {error}"})
                    self.status = "failed"
                except Exception:
                    pass
            self._halt_bench_soon()

    async def _pipeline(self) -> None:
        await self._sleep(80)
        self.status = "planning"
        self._emit("run.created", {"run": self._run_entity("planning")})

        plan = await self._call(self.bench.plan, self.task_prompt, self.profile)
        await self._sleep(600)
        # §5.7 rule 2: report plan_ready BEFORE blocking on plan approval.
        self._transition("plan_ready", "Plan ready for review")
        self._emit(
            "run.plan_generated",
            {"plan": plan.steps, "riskSummary": plan.risk_summary},
        )
        await self._wait_gate("plan")
        self._transition("running", "Plan approved")

        max_iterations = int(self.profile.get("safety", {}).get("maxIterations", 3))
        while True:
            all_pass, failed_checks = await self._iteration()
            if all_pass:
                report = await self._call(self.bench.report, self.iteration)
                await self._run_step("report", 5, "Generate validation report", report)
                report_id = self._artifact_ids.get("report", "")
                self._emit(
                    "run.completed",
                    {
                        "summary": self.bench.run_summary(self.iteration, True),
                        "reportArtifactId": report_id,
                    },
                )
                self.status = "completed"
                return

            self._transition(
                "diagnosing", f"{len(failed_checks)} of 3 checks failed"
            )
            diag_step, diagnosis = await self._call(
                self.bench.diagnose, self.iteration, failed_checks
            )
            step_id = await self._run_step(
                "diagnose", 4, "Diagnose failed checks", diag_step
            )
            self._emit(
                "diagnosis.created",
                {
                    "diagnosis": {
                        "id": f"diag_iter{self.iteration}_{self._suffix}",
                        "runId": self.id,
                        "failedCheckIds": [check["id"] for check in failed_checks],
                        "hypotheses": diagnosis.hypotheses,
                        "proposedFix": diagnosis.proposed_fix,
                    }
                },
            )

            if diagnosis.fix_approval is None or self.iteration >= max_iterations:
                self._emit(
                    "run.failed",
                    {"summary": self.bench.run_summary(self.iteration, False)},
                )
                self.status = "failed"
                self._halt_bench_soon()
                return

            if not await self._approval_gate(diagnosis.fix_approval):
                return
            self.iteration += 1
            self._transition(
                "running", f"Fix approved - starting iteration {self.iteration}"
            )
            self._emit(
                "run.iteration_started",
                {
                    "iteration": self.iteration,
                    "reason": self.bench.iteration_reason(self.iteration),
                },
            )

    async def _iteration(self) -> tuple[bool, list[dict[str, Any]]]:
        """One build→flash→capture→evaluate pass. Returns (all_pass, failed)."""
        context = await self._call(self.bench.understand_context, self.iteration)
        if context is not None:
            await self._run_step(
                "understand_context", 0, "Understand context", context
            )

        edit = await self._call(self.bench.edit_code, self.iteration)
        if edit is not None:
            title = (
                "Modify firmware"
                if self.iteration == 1
                else f"Apply fix (iteration {self.iteration})"
            )
            await self._run_step("edit_code", 1, title, edit)

        build = await self._call(self.bench.build, self.iteration)
        await self._run_step(
            "build",
            2,
            "Build firmware"
            + (f" (iteration {self.iteration})" if self.iteration > 1 else ""),
            build,
        )

        # Approvals block: the gate resolves over HTTP before flash() may run.
        approval = self.bench.flash_approval(self.iteration)
        if approval is not None:
            if not await self._approval_gate(approval):
                raise RunTerminated(self.id)
            self._transition("running", "Flash approved")
        flash = await self._call(self.bench.flash, self.iteration)
        await self._run_step(
            "flash",
            2,
            "Flash firmware"
            + (f" (iteration {self.iteration})" if self.iteration > 1 else ""),
            flash,
        )

        capture = await self._call(self.bench.capture, self.iteration)
        if capture is not None:
            await self._run_step(
                "capture",
                3,
                "Capture I2C bus"
                + (f" (iteration {self.iteration})" if self.iteration > 1 else ""),
                capture,
            )

        serial = await self._call(self.bench.read_serial, self.iteration)
        await self._run_step(
            "read_serial",
            3,
            "Read serial output"
            + (f" (iteration {self.iteration})" if self.iteration > 1 else ""),
            serial,
        )

        eval_step, checks = await self._call(self.bench.evaluate, self.iteration)
        await self._sleep(eval_step.delay_ms)
        step_id = f"st_evaluate_iter{self.iteration}_{self._suffix}"
        self._emit(
            "step.started",
            {
                "step": {
                    "id": step_id,
                    "runId": self.id,
                    "planIndex": 4,
                    "kind": "evaluate",
                    "status": "active",
                    "title": "Validate measurements"
                    + (f" (iteration {self.iteration})" if self.iteration > 1 else ""),
                    "startedAt": self.clock.now_iso(),
                    "artifactIds": [],
                }
            },
        )
        failed: list[dict[str, Any]] = []
        for check in checks:
            await self._sleep(300)
            entity = self._emit_check(check)
            if entity["verdict"] == "fail":
                failed.append(entity)
        self._emit(
            "step.completed" if not failed else "step.failed",
            {"stepId": step_id, "summary": eval_step.summary, "artifactIds": []},
        )
        return (not failed, failed)
