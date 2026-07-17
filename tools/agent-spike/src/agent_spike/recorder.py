"""Fixture-format run recorder.

Appends {"delayMs": N, "event": {...}} lines to <record>/recorded_run.jsonl in
the exact packages/contract fixture format: gapless seq from 1, envelope ts,
contract-valid payloads (validated line-by-line at write time), run.created
opens, exactly one terminal event closes. Artifact bytes land in
<record>/artifacts/<artifactId><ext> so the mock runner can serve them by id.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .contract import (
    DELAY_MS_CAP,
    EXTENSION_BY_KIND,
    LEGAL_TRANSITIONS,
    MIME_BY_KIND,
    TERMINAL_STATUSES,
    ContractViolation,
    validate_event,
)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class RunRecorder:
    def __init__(self, record_dir: Path, run_id: str, repo_root: Path) -> None:
        self.record_dir = Path(record_dir)
        self.artifacts_dir = self.record_dir / "artifacts"
        self.record_dir.mkdir(parents=True, exist_ok=True)
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        self.jsonl_path = self.record_dir / "recorded_run.jsonl"
        if self.jsonl_path.exists():
            raise ContractViolation(f"{self.jsonl_path} already exists; refusing to append to an old run")
        self.run_id = run_id
        self.repo_root = repo_root
        self.seq = 0
        self.status: str | None = None  # last emitted run status
        self.sealed = False
        self.terminal_type: str | None = None  # completed | failed | stopped
        self._last_emit_monotonic: float | None = None
        self._artifact_ids: set[str] = set()
        self._step_counter = 0
        self._artifact_counter = 0
        self._approval_counter = 0

    # ---- id helpers ------------------------------------------------------
    def next_step_id(self, kind: str) -> str:
        self._step_counter += 1
        return f"st_{self._step_counter:03d}_{kind}"

    def next_artifact_id(self, kind: str) -> str:
        self._artifact_counter += 1
        return f"art_{self._artifact_counter:03d}_{kind}"

    def next_approval_id(self) -> str:
        self._approval_counter += 1
        return f"apr_{self._approval_counter:03d}"

    def has_artifact(self, artifact_id: str) -> bool:
        return artifact_id in self._artifact_ids

    # ---- core emit -------------------------------------------------------
    def emit(self, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        if self.sealed:
            raise ContractViolation(
                f"attempted to emit {event_type} after the terminal event (log is sealed)"
            )
        now = time.monotonic()
        delay_ms = 0
        if self._last_emit_monotonic is not None:
            delay_ms = min(DELAY_MS_CAP, max(0, int((now - self._last_emit_monotonic) * 1000)))
        self._last_emit_monotonic = now

        event = {
            "seq": self.seq + 1,
            "runId": self.run_id,
            "ts": _iso_now(),
            "type": event_type,
            "payload": payload,
        }
        validate_event(self.repo_root, event)
        self.seq += 1
        with self.jsonl_path.open("a") as fh:
            fh.write(json.dumps({"delayMs": delay_ms, "event": event}) + "\n")

        if event_type in ("run.completed", "run.failed", "run.stopped"):
            self.sealed = True
            self.terminal_type = event_type.split(".", 1)[1]
        return event

    # ---- typed emitters ----------------------------------------------------
    def run_created(self, run: dict[str, Any]) -> None:
        if self.seq != 0:
            raise ContractViolation("run.created must be the first event")
        self.status = run["status"]
        self.emit("run.created", {"run": run})

    def status_changed(self, status: str, reason: str | None = None) -> None:
        if self.status is None:
            raise ContractViolation("status change before run.created")
        if status not in LEGAL_TRANSITIONS.get(self.status, set()):
            raise ContractViolation(
                f"illegal status transition {self.status} -> {status} (BIBLE §5.7)"
            )
        payload: dict[str, Any] = {"status": status}
        if reason:
            payload["reason"] = reason
        self.emit("run.status_changed", payload)
        self.status = status

    def add_artifact(
        self,
        *,
        kind: str,
        label: str,
        step_id: str,
        content: bytes,
        mime_type: str | None = None,
    ) -> str:
        artifact_id = self.next_artifact_id(kind)
        path = self.artifacts_dir / f"{artifact_id}{EXTENSION_BY_KIND[kind]}"
        path.write_bytes(content)
        artifact = {
            "id": artifact_id,
            "runId": self.run_id,
            "stepId": step_id,
            "kind": kind,
            "label": label,
            "mimeType": mime_type or MIME_BY_KIND[kind],
            "sizeBytes": path.stat().st_size,
        }
        self.emit("artifact.created", {"artifact": artifact})
        self._artifact_ids.add(artifact_id)
        return artifact_id

    def close(self) -> None:
        if not self.sealed:
            raise ContractViolation(
                "recorder closed without a terminal event (run.completed/failed/stopped)"
            )


def iso_now() -> str:
    return _iso_now()
