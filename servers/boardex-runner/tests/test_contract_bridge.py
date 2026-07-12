"""The contract bridge: schema location, versions, and outbound validation."""

from __future__ import annotations

import pytest

from boardex_runner.contract import (
    CONTRACT_VERSION,
    STATUS_TRANSITIONS,
    ContractViolation,
    schema_contract_version,
    schema_dir,
    validate_artifact_content,
    validate_event,
)


def test_schema_dir_resolves_to_contract_package() -> None:
    directory = schema_dir()
    assert (directory / "events.schema.json").is_file()
    assert (directory / "commands.schema.json").is_file()
    assert (directory / "artifacts.schema.json").is_file()


def test_contract_version_matches_emitted_schema() -> None:
    # /health must report the same version the contract package emits (§10.1).
    assert schema_contract_version() == CONTRACT_VERSION


def test_validate_event_accepts_a_conforming_envelope() -> None:
    validate_event(
        {
            "seq": 1,
            "runId": "run_x",
            "ts": "2026-07-12T14:00:00.000Z",
            "type": "run.stopped",
            "payload": {"byUser": True},
        }
    )


def test_validate_event_rejects_bad_payloads_and_envelopes() -> None:
    with pytest.raises(ContractViolation):
        validate_event(
            {
                "seq": 1,
                "runId": "run_x",
                "ts": "2026-07-12T14:00:00.000Z",
                "type": "run.stopped",
                "payload": {"byUser": False},  # contract: literal true
            }
        )
    with pytest.raises(ContractViolation):
        validate_event({"seq": 1, "type": "run.stopped", "payload": {"byUser": True}})


def test_validate_artifact_content_enforces_structured_kinds() -> None:
    validate_artifact_content(
        "timing_measurement",
        {"measurement": "logic_analyzer.i2c.scl_frequency", "valueHz": 99700},
    )
    with pytest.raises(ContractViolation):
        validate_artifact_content("timing_measurement", {"valueHz": "fast"})
    # Non-structured kinds are not schema-checked.
    validate_artifact_content("serial_log", "anything")


def test_transition_graph_matches_bible_5_7() -> None:
    # Terminal states have no outgoing edges (§5.7 rule 1).
    for terminal in ("completed", "failed", "stopped"):
        assert STATUS_TRANSITIONS[terminal] == frozenset()
    # Every non-terminal state can reach stopped (user stop).
    for status, targets in STATUS_TRANSITIONS.items():
        if status not in ("completed", "failed", "stopped"):
            assert "stopped" in targets
    # The plan gate is visible state: planning cannot jump straight to running.
    assert "running" not in STATUS_TRANSITIONS["planning"]
    assert "running" in STATUS_TRANSITIONS["plan_ready"]
