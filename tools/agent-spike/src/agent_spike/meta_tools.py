"""Harness meta-tools (spec §4): structured product events are emitted by tool
call, never parsed out of prose. Each payload is validated here against the
contract shapes; a malformed payload fails visibly, the model is told why, and
gets exactly one retry per tool before the run aborts as failed (§3.5 fail-closed).
"""

from __future__ import annotations

from typing import Any

RISK_LEVELS = ["low", "medium", "high", "critical"]
VERDICTS = ["pass", "fail", "needs_review"]
CONFIDENCE = ["high", "moderate", "low"]

# Every tool (meta and hardware) carries an optional harness-only `_plan_index`
# the model uses to tie the resulting step to its declared plan row. The
# harness strips it before validation/dispatch; it never crosses to MCP.
PLAN_INDEX_PROP = {
    "_plan_index": {
        "type": "integer",
        "minimum": 0,
        "description": "Index of the declared plan step this action belongs to.",
    }
}

_EXPECTED_SCHEMA = {
    "type": "object",
    "description": "Expected window/value, MeasurementCheck.expected shape.",
    "properties": {
        "min": {"type": "number"},
        "max": {"type": "number"},
        "equals": {"type": ["boolean", "string"]},
        "pattern": {"type": "string"},
    },
    "additionalProperties": False,
}

META_TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    "declare_plan": {
        "description": (
            "Declare the run plan before any execution. Steps are plain-language and "
            "ordered; checks register every measurable requirement you will later "
            "prove with record_check. The run parks for human plan approval after "
            "this call; hardware tools bind only once the plan is approved."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "detail": {"type": "string"},
                            "riskLevel": {"type": "string", "enum": RISK_LEVELS},
                            "hardwareAction": {"type": "boolean"},
                        },
                        "required": ["title", "detail", "riskLevel", "hardwareAction"],
                        "additionalProperties": False,
                    },
                },
                "risk_summary": {"type": "string"},
                "checks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "requirementId": {"type": "string"},
                            "description": {"type": "string"},
                            "measurement": {"type": "string"},
                            "expected": _EXPECTED_SCHEMA,
                        },
                        "required": ["requirementId", "description", "measurement", "expected"],
                        "additionalProperties": False,
                    },
                },
                **PLAN_INDEX_PROP,
            },
            "required": ["steps", "risk_summary", "checks"],
            "additionalProperties": False,
        },
    },
    "record_check": {
        "description": (
            "Record the measured outcome of a check registered in declare_plan. "
            "artifactId MUST reference an artifact that already exists in this run "
            "(the evidence law): a claim without evidence does not count."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "requirementId": {"type": "string"},
                "actual": {
                    "type": "object",
                    "properties": {
                        "value": {"type": ["number", "boolean", "string"]},
                        "unit": {"type": "string"},
                    },
                    "required": ["value"],
                    "additionalProperties": False,
                },
                "verdict": {"type": "string", "enum": VERDICTS},
                "artifactId": {"type": "string"},
                "sourceRef": {"type": "string"},
                "sourceDoc": {
                    "type": "object",
                    "properties": {
                        "documentId": {"type": "string"},
                        "locator": {"type": "string"},
                    },
                    "required": ["documentId"],
                    "additionalProperties": False,
                },
                **PLAN_INDEX_PROP,
            },
            "required": ["requirementId", "actual", "verdict", "artifactId"],
            "additionalProperties": False,
        },
    },
    "declare_diagnosis": {
        "description": (
            "After one or more checks failed, declare the root-cause analysis: the "
            "failed check ids, ranked hypotheses with evidence, and one proposed fix. "
            "The proposed fix parks the run for human approval."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "failedCheckIds": {
                    "type": "array",
                    "minItems": 1,
                    "items": {"type": "string"},
                },
                "hypotheses": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "cause": {"type": "string"},
                            "evidence": {"type": "string"},
                            "confidence": {"type": "string", "enum": CONFIDENCE},
                        },
                        "required": ["cause", "evidence", "confidence"],
                        "additionalProperties": False,
                    },
                },
                "proposedFix": {
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string"},
                        "riskLevel": {"type": "string", "enum": RISK_LEVELS},
                        "filesChanged": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["summary", "riskLevel", "filesChanged"],
                    "additionalProperties": False,
                },
                **PLAN_INDEX_PROP,
            },
            "required": ["failedCheckIds", "hypotheses", "proposedFix"],
            "additionalProperties": False,
        },
    },
    "declare_iteration": {
        "description": (
            "Start the next fix iteration (iteration 2+). Call after an approved fix, "
            "before re-executing. The harness enforces the iteration bound."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {"type": "string"},
                **PLAN_INDEX_PROP,
            },
            "required": ["reason"],
            "additionalProperties": False,
        },
    },
    "write_report": {
        "description": (
            "Write the final evidence-linked Markdown report and end the run. The run "
            "completes only if every registered check has a recorded pass verdict; "
            "otherwise it ends as honestly failed. Every conclusion in the report must "
            "cite an artifact."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "markdown": {"type": "string", "minLength": 1},
                **PLAN_INDEX_PROP,
            },
            "required": ["markdown"],
            "additionalProperties": False,
        },
    },
}

META_TOOL_NAMES = frozenset(META_TOOL_SCHEMAS)


def meta_tools_as_openai() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": spec["description"],
                "parameters": spec["parameters"],
            },
        }
        for name, spec in META_TOOL_SCHEMAS.items()
    ]
