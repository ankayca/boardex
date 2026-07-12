"""Per-run append-only event log with gapless seq (BIBLE §5.1).

Every append is validated against ``events.schema.json`` before it becomes
visible anywhere — the log IS the wire truth, and a non-conforming event must
never reach it. Terminal events seal the log; appending past a terminal event
raises ``RunTerminated`` so no code path can violate §5.7 rule 1.
"""

from __future__ import annotations

from typing import Any, Callable

from .contract import TERMINAL_STATUSES, validate_event

TERMINAL_EVENT_TYPES = frozenset({"run.completed", "run.failed", "run.stopped"})


class RunTerminated(Exception):
    """Raised on any attempt to emit past a terminal event."""


class EventLog:
    """Owns seq assignment, validation, storage and fan-out for one run."""

    def __init__(
        self,
        run_id: str,
        on_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.run_id = run_id
        self.events: list[dict[str, Any]] = []
        self._on_event = on_event
        self._sealed = False

    @property
    def next_seq(self) -> int:
        return len(self.events) + 1

    @property
    def sealed(self) -> bool:
        return self._sealed

    def append(self, type_: str, payload: dict[str, Any], ts: str) -> dict[str, Any]:
        if self._sealed:
            raise RunTerminated(
                f"run {self.run_id} is terminal; refusing to emit {type_!r}"
            )
        event = {
            "seq": self.next_seq,
            "runId": self.run_id,
            "ts": ts,
            "type": type_,
            "payload": payload,
        }
        validate_event(event)
        if type_ in TERMINAL_EVENT_TYPES:
            self._sealed = True
        # §5.7 defensive check: a status_changed carrying a terminal status also
        # seals nothing here (the dedicated event follows), but a terminal event
        # type is final.
        self.events.append(event)
        if self._on_event is not None:
            self._on_event(event)
        return event

    def after(self, after_seq: int) -> list[dict[str, Any]]:
        """HTTP replay body (§5.3): every event with seq > afterSeq, in order."""
        if after_seq <= 0:
            return list(self.events)
        return [event for event in self.events if event["seq"] > after_seq]

    def has_type(self, type_: str) -> bool:
        return any(event["type"] == type_ for event in self.events)

    def last(self) -> dict[str, Any] | None:
        return self.events[-1] if self.events else None


def is_terminal_status(status: str) -> bool:
    return status in TERMINAL_STATUSES
