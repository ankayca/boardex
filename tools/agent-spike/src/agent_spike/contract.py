"""Contract bridge: the emitted JSON Schema is the only cross-language source
of truth (BIBLE §3). Every outbound event is validated against
packages/contract/json-schema/events.schema.json at write time — fail loud.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema

_SCHEMA_CACHE: dict[str, jsonschema.Draft7Validator] = {}


def find_repo_root(start: Path | None = None) -> Path:
    """Walk up from this file to the checkout root (the dir holding packages/)."""
    here = start or Path(__file__).resolve()
    for parent in [here, *here.parents]:
        if (parent / "packages" / "contract" / "json-schema" / "events.schema.json").is_file():
            return parent
    raise FileNotFoundError(
        "Could not locate packages/contract/json-schema/events.schema.json above "
        f"{here}; run from inside the boardex checkout."
    )


def _load_schema(repo_root: Path) -> dict[str, Any]:
    path = repo_root / "packages" / "contract" / "json-schema" / "events.schema.json"
    return json.loads(path.read_text())


def event_validator(repo_root: Path) -> jsonschema.Draft7Validator:
    key = str(repo_root)
    if key not in _SCHEMA_CACHE:
        _SCHEMA_CACHE[key] = jsonschema.Draft7Validator(_load_schema(repo_root))
    return _SCHEMA_CACHE[key]


def definition_validator(repo_root: Path, definition: str) -> jsonschema.Draft7Validator:
    """Validator for one #/definitions/<name> shape (PlanStep, MeasurementCheck, ...)."""
    key = f"{repo_root}#{definition}"
    if key not in _SCHEMA_CACHE:
        schema = _load_schema(repo_root)
        _SCHEMA_CACHE[key] = jsonschema.Draft7Validator(
            {"$ref": f"#/definitions/{definition}", "definitions": schema["definitions"]}
        )
    return _SCHEMA_CACHE[key]


class ContractViolation(Exception):
    """An event or payload we were about to emit does not match the contract."""


def validate_event(repo_root: Path, event: dict[str, Any]) -> None:
    errors = sorted(event_validator(repo_root).iter_errors(event), key=str)
    if errors:
        raise ContractViolation(
            f"event seq={event.get('seq')} type={event.get('type')} violates "
            f"events.schema.json: {errors[0].message}"
        )


def validate_definition(repo_root: Path, definition: str, payload: Any) -> list[str]:
    """Return human-readable schema errors ([] when valid)."""
    validator = definition_validator(repo_root, definition)
    return [
        f"{'/'.join(str(p) for p in err.absolute_path) or '<root>'}: {err.message}"
        for err in sorted(validator.iter_errors(payload), key=str)
    ]


# BIBLE §5.7 — the normative status transition table. The recorder refuses to
# emit an illegal edge so a spike bug can never produce a non-conformant stream.
LEGAL_TRANSITIONS: dict[str, set[str]] = {
    "draft": {"planning"},
    "planning": {"plan_ready", "stopped", "failed"},
    "plan_ready": {"running", "stopped", "failed"},
    "running": {"awaiting_approval", "diagnosing", "completed", "failed", "stopped"},
    "awaiting_approval": {"running", "stopped", "failed"},
    "diagnosing": {"awaiting_approval", "failed", "stopped"},
    "completed": set(),
    "failed": set(),
    "stopped": set(),
}

TERMINAL_STATUSES = {"completed", "failed", "stopped"}

# Mirrors tools/mock-runner/src/fixture.ts EXTENSION_BY_KIND so recorded
# artifacts are servable by <artifactId><ext> convention with zero glue.
EXTENSION_BY_KIND: dict[str, str] = {
    "serial_log": ".log",
    "build_log": ".log",
    "flash_log": ".log",
    "logic_capture": ".sr",
    "protocol_decode": ".json",
    "code_diff": ".json",
    "timing_measurement": ".json",
    "report_md": ".md",
}

MIME_BY_KIND: dict[str, str] = {
    "serial_log": "text/plain",
    "build_log": "text/plain",
    "flash_log": "text/plain",
    "logic_capture": "application/octet-stream",
    "protocol_decode": "application/json",
    "code_diff": "application/json",
    "timing_measurement": "application/json",
    "report_md": "text/markdown",
}

# Fixture-line pacing cap (packages/contract fixture.test.ts: 0 <= delayMs <= 20000).
DELAY_MS_CAP = 20_000
