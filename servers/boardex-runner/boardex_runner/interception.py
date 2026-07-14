"""Tool-call interception (RUNNER_AGENT_V0_SPEC §3.1) with the gate-floor
amendment (RUNNER_AUDIT_2026-07-13 MEDIUM-5): the risk list below is hardcoded
and no configuration path — board profile, bench config, or environment — can
remove it. A gated call parks on the engine's approval gate BEFORE the MCP
invocation; rejection returns a refusal result to the model and ends the run
as stopped.

The floor's contract rests on two explicit dependencies:

(a) The floor is destructive-only by design. Debug-control tools (halt, step,
    breakpoints, register/memory reads) are ungated; whether ``halt_target``
    on a live system counts as destructive is pending a backend-owner ruling.
(b) The naming convention is load-bearing: any future destructive MCP tool
    MUST either carry one of the risk name prefixes below or declare a
    mutation verb on the first line of its description. A destructive tool
    that does neither silently bypasses the floor.
"""

from __future__ import annotations

import re

# Name floor: anything starting with these prefixes mutates hardware state.
RISK_NAME_PREFIXES = ("flash_", "reset_", "erase_", "recover_", "write_")

# Composite tools whose names don't carry a risk prefix but which flash/reset
# internally (boardex-target composite.py).
RISK_NAMES = frozenset({"run_checkpoint", "verify_bringup"})

# Description floor: a tool whose own summary line declares a hardware
# mutation is gated even if its name matches nothing above. Only the first
# line is scanned so a read-only tool that merely *mentions* e.g. reset_target
# in its usage notes is not swept in.
_MUTATION_VERBS = re.compile(
    r"\b(flash(es|ing)?|erase[sd]?|erasing|reset(s|ting)?|write[s]?|program(s|ming)?)\b",
    re.IGNORECASE,
)

RISK_LEVEL_BY_TOOL = {
    "recover_target": "high",  # mass-erases flash by default
}
DEFAULT_RISK_LEVEL = "medium"


def is_risk_gated(tool_name: str, description: str | None) -> bool:
    if tool_name.startswith(RISK_NAME_PREFIXES):
        return True
    if tool_name in RISK_NAMES:
        return True
    first_line = (description or "").strip().splitlines()[:1]
    return bool(first_line and _MUTATION_VERBS.search(first_line[0]))


def risk_level_for(tool_name: str) -> str:
    return RISK_LEVEL_BY_TOOL.get(tool_name, DEFAULT_RISK_LEVEL)
