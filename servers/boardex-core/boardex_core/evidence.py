"""Shared evidence shapes for multi-step bring-up workflows.

Domain servers (target, logic, scope, ...) assemble an ``EvidenceBundle`` so
agents get one structured pass/fail with RTT, bus decode, and debug context
instead of stitching several tool responses by hand.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .results import Verdict


@dataclass
class WorkflowStep:
    """One step in a composite workflow audit trail."""

    name: str
    verdict: str
    summary: str
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "verdict": self.verdict,
            "summary": self.summary,
            "data": self.data,
        }


@dataclass
class EvidenceBundle:
    """Bundled proof from a bring-up or verification workflow."""

    verdict: Verdict
    summary: str
    rtt: dict[str, Any] | None = None
    i2c: dict[str, Any] | None = None
    peripheral: dict[str, Any] | None = None
    hints: list[str] = field(default_factory=list)
    steps: list[WorkflowStep] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict.value,
            "summary": self.summary,
            "rtt": self.rtt,
            "i2c": self.i2c,
            "peripheral": self.peripheral,
            "hints": self.hints,
            "steps": [s.to_dict() for s in self.steps],
        }


def combine_verdicts(*verdicts: Verdict) -> Verdict:
    """Pick the worst outcome: error > fail > inconclusive > pass."""
    order = (Verdict.ERROR, Verdict.FAIL, Verdict.INCONCLUSIVE, Verdict.PASS)
    for v in order:
        if v in verdicts:
            return v
    return Verdict.PASS
