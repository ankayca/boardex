"""Read-only bridge to the UI contract (BIBLE §5 / §10.1).

The emitted JSON Schema in ``packages/contract/json-schema/`` is the only
cross-language spec. This module locates those files, exposes the contract
version, and provides validators the runner uses to check every outbound
event (and every structured artifact body) before it can reach the wire —
exactly as the mock runner does at send time.
"""

from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator

CONTRACT_VERSION = "boardex-contract/0.1"

# Fanned out to the global dashboard stream in addition to the per-run stream
# (BIBLE §5.3): run lifecycle plus the dedicated terminal events.
GLOBAL_EVENT_TYPES = frozenset(
    {
        "run.created",
        "run.status_changed",
        "run.completed",
        "run.failed",
        "run.stopped",
    }
)

TERMINAL_STATUSES = frozenset({"completed", "failed", "stopped"})

# §5.7 transition graph, normative. Key -> statuses reachable from it.
STATUS_TRANSITIONS: dict[str, frozenset[str]] = {
    "draft": frozenset({"planning", "stopped"}),
    "planning": frozenset({"plan_ready", "stopped"}),
    "plan_ready": frozenset({"running", "stopped"}),
    "running": frozenset({"awaiting_approval", "diagnosing", "completed", "failed", "stopped"}),
    "awaiting_approval": frozenset({"running", "stopped"}),
    "diagnosing": frozenset({"awaiting_approval", "failed", "stopped"}),
    "completed": frozenset(),
    "failed": frozenset(),
    "stopped": frozenset(),
}


class ContractViolation(Exception):
    """An outbound message failed contract validation. Loud by design."""


def schema_dir() -> Path:
    """Locate ``packages/contract/json-schema`` (env override, then repo walk)."""
    override = os.environ.get("BOARDEX_CONTRACT_SCHEMA_DIR")
    if override:
        path = Path(override)
        if path.is_dir():
            return path
        raise FileNotFoundError(f"BOARDEX_CONTRACT_SCHEMA_DIR={override} is not a directory")
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "packages" / "contract" / "json-schema"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError(
        "packages/contract/json-schema not found above "
        f"{Path(__file__).resolve()} (set BOARDEX_CONTRACT_SCHEMA_DIR)"
    )


@lru_cache(maxsize=None)
def _load_schema(name: str) -> dict[str, Any]:
    with open(schema_dir() / name, encoding="utf-8") as fh:
        return json.load(fh)


@lru_cache(maxsize=None)
def _validator(schema_name: str, definition: str | None = None) -> Draft7Validator:
    schema = dict(_load_schema(schema_name))
    if definition is not None:
        schema["$ref"] = f"#/definitions/{definition}"
    return Draft7Validator(schema)


def schema_contract_version() -> str:
    """The contract version stated inside the emitted event schema itself."""
    description = _load_schema("events.schema.json").get("description", "")
    match = re.search(r"boardex-contract/[\w.]+", description)
    if not match:
        raise ContractViolation("events.schema.json does not state a contract version")
    return match.group(0)


def validate_event(event: dict[str, Any]) -> dict[str, Any]:
    """Validate one outbound event envelope against the event catalog."""
    errors = sorted(_validator("events.schema.json").iter_errors(event), key=str)
    if errors:
        raise ContractViolation(
            f"outbound event (type={event.get('type')!r}, seq={event.get('seq')!r}) "
            f"violates events.schema.json: {errors[0].message}"
        )
    return event


_ARTIFACT_CONTENT_DEFS = {
    "protocol_decode": "ProtocolDecodeContent",
    "code_diff": "CodeDiffContent",
    "timing_measurement": "TimingMeasurementContent",
}


def validate_artifact_content(kind: str, content: Any) -> None:
    """Validate a structured artifact body against artifacts.schema.json."""
    definition = _ARTIFACT_CONTENT_DEFS.get(kind)
    if definition is None:
        return
    errors = sorted(
        _validator("artifacts.schema.json", definition).iter_errors(content), key=str
    )
    if errors:
        raise ContractViolation(
            f"artifact content (kind={kind!r}) violates {definition}: {errors[0].message}"
        )


def validate_command_body(definition: str, body: Any) -> bool:
    """Check an inbound request body against a commands.schema.json definition."""
    return not any(_validator("commands.schema.json", definition).iter_errors(body))


def definition_errors(definition: str, payload: Any) -> list[str]:
    """Human-readable errors for one events.schema.json definition ([] = valid).

    The agent bench validates model-authored entity payloads (PlanStep,
    MeasurementCheck, Diagnosis) BEFORE building an event around them, so the
    schema errors can be returned to the model as a retry instruction instead
    of dying inside the emit path.
    """
    validator = _validator("events.schema.json", definition)
    return [
        f"{'/'.join(str(p) for p in err.absolute_path) or '<root>'}: {err.message}"
        for err in sorted(validator.iter_errors(payload), key=str)
    ]
