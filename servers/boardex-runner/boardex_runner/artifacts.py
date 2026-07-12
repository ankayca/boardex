"""Artifact store: durable, addressable, served by reference (BIBLE §10.2.4).

Artifacts are never embedded in events — ``artifact.created`` announces the
metadata and the body is fetched via ``GET /artifacts/{id}``. Structured kinds
are validated against ``artifacts.schema.json`` at store time so a body the UI
cannot parse never becomes fetchable.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .contract import validate_artifact_content

MIME_BY_KIND = {
    "serial_log": "text/plain",
    "build_log": "text/plain",
    "flash_log": "text/plain",
    "logic_capture": "application/vnd.sigrok.session",
    "protocol_decode": "application/json",
    "code_diff": "application/json",
    "timing_measurement": "application/json",
    "report_md": "text/markdown",
}

EXT_BY_KIND = {
    "serial_log": "log",
    "build_log": "log",
    "flash_log": "log",
    "logic_capture": "sr",
    "protocol_decode": "json",
    "code_diff": "json",
    "timing_measurement": "json",
    "report_md": "md",
}


@dataclass(frozen=True)
class StoredArtifact:
    meta: dict[str, Any]  # the wire Artifact entity (§4)
    content: bytes

    @property
    def id(self) -> str:
        return str(self.meta["id"])


@dataclass
class ArtifactStore:
    """In-memory for the process lifetime, optionally mirrored to a directory."""

    data_dir: Path | None = None
    _by_id: dict[str, StoredArtifact] = field(default_factory=dict)

    def put(
        self,
        *,
        artifact_id: str,
        run_id: str,
        step_id: str,
        kind: str,
        label: str,
        content: bytes | str | dict[str, Any] | list[Any],
        mime_type: str | None = None,
    ) -> dict[str, Any]:
        """Store a body and return the wire ``Artifact`` metadata for it."""
        if isinstance(content, (dict, list)):
            validate_artifact_content(kind, content)
            body = json.dumps(content, indent=2).encode("utf-8")
        elif isinstance(content, str):
            body = content.encode("utf-8")
        else:
            body = content
            if kind in ("protocol_decode", "code_diff", "timing_measurement"):
                validate_artifact_content(kind, json.loads(body.decode("utf-8")))
        meta = {
            "id": artifact_id,
            "runId": run_id,
            "stepId": step_id,
            "kind": kind,
            "label": label,
            "mimeType": mime_type or MIME_BY_KIND[kind],
            "sizeBytes": len(body),
        }
        self._by_id[artifact_id] = StoredArtifact(meta=meta, content=body)
        if self.data_dir is not None:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            ext = EXT_BY_KIND.get(kind, "bin")
            (self.data_dir / f"{artifact_id}.{ext}").write_bytes(body)
        return meta

    def get(self, artifact_id: str) -> StoredArtifact | None:
        return self._by_id.get(artifact_id)

    def meta(self, artifact_id: str) -> dict[str, Any] | None:
        stored = self._by_id.get(artifact_id)
        return stored.meta if stored else None

    def __contains__(self, artifact_id: str) -> bool:
        return artifact_id in self._by_id
