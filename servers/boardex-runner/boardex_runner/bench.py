"""The bench abstraction the run engine drives.

A bench turns each pipeline stage into a ``StepResult`` (logs, artifacts,
verdict). Two implementations exist: ``FakeBench`` (deterministic, hardware
free — used by every test and the conformance suite) and ``RealBench``
(pyOCD + sigrok via the boardex-target / boardex-logic layers). The engine is
identical either way; only the bench differs, so what the conformance suite
proves about the wire layer holds on real hardware too.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass(frozen=True)
class LogChunk:
    """A batched slice of step.log lines (≤10 Hz discipline is inherent:
    one chunk = one step.log event). ``delay_ms`` paces the chunk."""

    stream: str  # 'build' | 'flash' | 'serial' | 'rtt' | 'agent'
    lines: list[str]
    delay_ms: int = 0


@dataclass(frozen=True)
class ArtifactSpec:
    """An artifact body the engine will store and announce by reference."""

    name: str  # stable local name, e.g. "diff_iter1"; the engine derives the id
    kind: str
    label: str
    content: bytes | str | dict[str, Any] | list[Any]
    mime_type: str | None = None


@dataclass(frozen=True)
class StepResult:
    ok: bool
    summary: str
    logs: list[LogChunk] = field(default_factory=list)
    artifacts: list[ArtifactSpec] = field(default_factory=list)
    delay_ms: int = 0  # pacing before the step starts


@dataclass(frozen=True)
class CheckSpec:
    """One MeasurementCheck; ``artifact_name`` must resolve to an artifact the
    same run already announced (evidence-linking law, BIBLE §4)."""

    requirement_id: str
    description: str
    measurement: str
    expected: dict[str, Any]
    actual: dict[str, Any]
    verdict: str  # 'pass' | 'fail' | 'needs_review'
    artifact_name: str
    source_ref: str | None = None


@dataclass(frozen=True)
class ApprovalSpec:
    title: str
    reason: str
    risk_level: str
    files_changed: list[str]
    hardware_actions: list[str]
    status_reason: str  # the run.status_changed reason for the pause


@dataclass(frozen=True)
class DiagnosisSpec:
    hypotheses: list[dict[str, Any]]  # { cause, evidence, confidence }
    proposed_fix: dict[str, Any]  # { summary, riskLevel, filesChanged }
    fix_approval: ApprovalSpec | None  # None => nothing left to propose


@dataclass(frozen=True)
class PlanSpec:
    steps: list[dict[str, Any]]  # PlanStep entities (§4)
    risk_summary: str


@runtime_checkable
class Bench(Protocol):
    """Pipeline stages. Any stage returning ``None`` is skipped (not emitted).

    Methods may block (real hardware); the engine runs them off the event loop
    when ``blocking`` is true.

    ``exclusive`` marks a bench backed by a single physical bench (one probe,
    one analyzer): the server refuses to start a second run while another is
    non-terminal (audit HIGH-1). Hardware-free benches (``FakeBench``) are not
    exclusive — their per-run instances share nothing.
    """

    blocking: bool
    exclusive: bool

    def bench_status(self) -> dict[str, Any]: ...

    def plan(self, task_prompt: str, profile: dict[str, Any]) -> PlanSpec: ...

    def understand_context(self, iteration: int) -> StepResult | None: ...

    def edit_code(self, iteration: int) -> StepResult | None: ...

    def build(self, iteration: int) -> StepResult: ...

    def flash_approval(self, iteration: int) -> ApprovalSpec | None: ...

    def flash(self, iteration: int) -> StepResult: ...

    def capture(self, iteration: int) -> StepResult | None: ...

    def read_serial(self, iteration: int) -> StepResult: ...

    def evaluate(self, iteration: int) -> tuple[StepResult, list[CheckSpec]]: ...

    def diagnose(
        self, iteration: int, failed: list[dict[str, Any]]
    ) -> tuple[StepResult, DiagnosisSpec]: ...

    def iteration_reason(self, iteration: int) -> str: ...

    def report(self, iteration: int) -> StepResult: ...

    def run_summary(self, iteration: int, completed: bool) -> str: ...

    def halt(self) -> None:
        """Hardware-safe stop: close sessions, stop RTT and captures."""
        ...
