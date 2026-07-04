"""Structured, agent-friendly results shared by every Boardex operation.

Every tool in every Boardex MCP server returns an ``OperationResult``. Agents
branch on the machine-readable ``Verdict`` rather than parsing prose, which is
what makes the flash -> test -> verify loop deterministic.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class Verdict(str, Enum):
    """The four outcomes an agent needs to distinguish.

    ``str`` mixin so the value serialises directly to JSON as e.g. ``"pass"``.
    """

    PASS = "pass"
    FAIL = "fail"  # operation ran, but the result did not meet the spec
    ERROR = "error"  # operation could not run (hardware/backend problem)
    INCONCLUSIVE = "inconclusive"  # ran, but we cannot judge pass/fail yet


@dataclass
class OperationResult:
    """Uniform return value for every Boardex operation.

    Attributes:
        verdict: Machine-readable outcome the agent branches on.
        summary: One-line human-readable explanation (also useful to the agent).
        data: Structured payload (measurements, memory dumps, device lists...).
        warnings: Non-fatal notes worth surfacing to the engineer.
        duration_s: Wall-clock time the operation took, when measured.
    """

    verdict: Verdict
    summary: str
    data: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    duration_s: float | None = None

    @property
    def ok(self) -> bool:
        """True only when the operation fully succeeded."""
        return self.verdict == Verdict.PASS

    def to_dict(self) -> dict[str, Any]:
        """JSON-serialisable form returned across the MCP boundary."""
        payload = asdict(self)
        payload["verdict"] = self.verdict.value
        return payload

    # Convenience constructors keep call sites terse and consistent.
    @classmethod
    def passed(cls, summary: str, **data: Any) -> "OperationResult":
        return cls(Verdict.PASS, summary, data=dict(data))

    @classmethod
    def failed(cls, summary: str, **data: Any) -> "OperationResult":
        return cls(Verdict.FAIL, summary, data=dict(data))

    @classmethod
    def errored(cls, summary: str, **data: Any) -> "OperationResult":
        return cls(Verdict.ERROR, summary, data=dict(data))

    @classmethod
    def inconclusive(cls, summary: str, **data: Any) -> "OperationResult":
        return cls(Verdict.INCONCLUSIVE, summary, data=dict(data))
