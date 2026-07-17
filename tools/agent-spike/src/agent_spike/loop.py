"""The agent loop: two phases (spec §2), harness-enforced safety (spec §3),
meta-tool event mapping (spec §4), fixture-format recording throughout.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol

import jsonschema

from . import prompts
from .contract import validate_definition
from .interception import is_risk_gated, risk_level_for
from .meta_tools import META_TOOL_NAMES, META_TOOL_SCHEMAS, meta_tools_as_openai
from .provider import MalformedToolArguments, ModelTurn, ToolCall
from .recorder import RunRecorder, iso_now
from .workspace import (
    WORKSPACE_TOOL_NAMES,
    Workspace,
    WorkspaceError,
    diff_artifact_bytes,
    workspace_tools_as_openai,
)

TOOL_RESULT_CAP = 16_000
MAX_IDLE_TURNS = 3  # consecutive assistant turns with no tool call

Approver = Callable[[str], bool]


class ToolHost(Protocol):
    """What the loop needs from the MCP layer (real host or test fake)."""

    tool_specs: list[dict[str, Any]]
    descriptions: dict[str, str]

    def has_tool(self, name: str) -> bool: ...
    async def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]: ...


class BoundsExceeded(Exception):
    pass


class MetaToolAbort(Exception):
    """A meta-tool payload was malformed twice — fail closed, abort the run."""


class RunStopped(Exception):
    """A human rejected a gate; the run has already emitted its terminal events."""


# ---- tool -> StepKind / log-stream mapping ---------------------------------
_KIND_FLASH = {
    "flash_firmware", "reset_target", "recover_target", "write_memory",
    "write_register", "halt_target", "resume_target", "run_checkpoint",
    "verify_bringup",
}
_KIND_CAPTURE = {"capture", "decode_bus", "capture_during", "get_capabilities"}
_KIND_RTT = {
    "read_firmware_log", "read_rtt", "wait_for_rtt", "start_rtt", "stop_rtt",
    "prepare_session", "open_session", "close_session",
}


def kind_for_tool(name: str) -> str:
    if name == "build_firmware":
        return "build"
    if name in _KIND_FLASH:
        return "flash"
    if name in _KIND_CAPTURE:
        return "capture"
    if name in _KIND_RTT:
        return "read_serial"
    if name == "write_file":
        return "edit_code"
    return "understand_context"


_STREAM_BY_KIND = {
    "build": "build",
    "flash": "flash",
    "read_serial": "rtt",
}


def stream_for_kind(kind: str) -> str:
    return _STREAM_BY_KIND.get(kind, "agent")


@dataclass
class RunConfig:
    task: str
    repo: Path
    model: str
    record_dir: Path
    max_turns: int = 40
    max_iterations: int = 3
    run_id: str = "run_spike_001"
    # Must reference a profile the replaying runner can resolve: the UI blocks
    # plan approval on an unresolvable profile (fails closed). The mock ships
    # exactly one canned profile, the Nucleo-F303RE.
    board_profile_id: str = "bp_nucleo_f303re"
    title: str = ""

    def __post_init__(self) -> None:
        if not self.title:
            self.title = self.task.strip().splitlines()[0][:80]


@dataclass
class Harness:
    cfg: RunConfig
    recorder: RunRecorder
    provider: Any  # Provider protocol
    workspace: Workspace
    approver: Approver
    # Called after plan approval; returns the bound MCP host (or None when the
    # bench is unavailable — execution then has workspace+meta tools only).
    toolhost_factory: Callable[[], Awaitable[ToolHost | None]]

    messages: list[dict[str, Any]] = field(default_factory=list)
    turns: int = 0
    iteration: int = 1
    plan: list[dict[str, Any]] | None = None
    registered_checks: dict[str, dict[str, Any]] = field(default_factory=dict)
    check_verdicts: dict[str, str] = field(default_factory=dict)
    meta_failures: dict[str, int] = field(default_factory=dict)
    narration: list[str] = field(default_factory=list)
    current_plan_index: int = 0
    report_warned: bool = False
    mcp: ToolHost | None = None
    _diag_counter: int = 0

    # ------------------------------------------------------------------ core
    async def run(self) -> str:
        """Execute the whole run; returns the terminal status."""
        self.recorder.run_created(
            {
                "id": self.cfg.run_id,
                "title": self.cfg.title,
                "taskPrompt": self.cfg.task,
                "boardProfileId": self.cfg.board_profile_id,
                "status": "planning",
                "createdAt": iso_now(),
                "updatedAt": iso_now(),
                "iteration": 1,
                "model": self.cfg.model,
            }
        )
        try:
            await self._plan_phase()
            await self._execute_phase()
        except RunStopped:
            pass
        except BoundsExceeded as exc:
            await self._fail_with_partial_report(str(exc))
        except MetaToolAbort as exc:
            if not self.recorder.sealed:
                self.recorder.emit("run.failed", {"summary": f"Aborted (fail closed): {exc}"})
        self.recorder.close()
        return self.recorder.terminal_type or "unknown"

    # ------------------------------------------------------------ plan phase
    async def _plan_phase(self) -> None:
        self.messages = [
            {"role": "system", "content": prompts.SYSTEM_PROMPT},
            {
                "role": "user",
                "content": prompts.plan_phase_user_message(
                    self.cfg.task,
                    str(self.workspace.repo),
                    self.workspace.tree_snapshot(),
                    prompts.BENCH_NOTE_DEFAULT,
                ),
            },
        ]
        idle = 0
        while self.plan is None:
            turn = await self._complete(meta_tools_as_openai())
            if turn is None:
                continue
            if turn.content:
                self.narration.append(turn.content)
            if not turn.tool_calls:
                idle += 1
                if idle >= MAX_IDLE_TURNS:
                    raise MetaToolAbort("agent never called declare_plan in the plan phase")
                self.messages.append(
                    {"role": "user", "content": "You must call declare_plan to proceed."}
                )
                continue
            for call in turn.tool_calls:
                if self.plan is None and call.name == "declare_plan":
                    self._respond(call, self._handle_declare_plan(call))
                else:
                    self._respond(
                        call,
                        json.dumps({"error": "Only declare_plan is valid during the plan phase."}),
                    )

    def _handle_declare_plan(self, call: ToolCall) -> str:
        args = dict(call.arguments)
        args.pop("_plan_index", None)
        errors = self._schema_errors("declare_plan", args)
        if errors:
            return self._meta_failure("declare_plan", errors)
        plan = [
            {
                "index": i,
                "title": s["title"],
                "detail": s["detail"],
                "riskLevel": s["riskLevel"],
                "hardwareAction": s["hardwareAction"],
            }
            for i, s in enumerate(args["steps"])
        ]
        for step in plan:
            defects = validate_definition(self.recorder.repo_root, "PlanStep", step)
            if defects:
                return self._meta_failure("declare_plan", defects)
        for check in args["checks"]:
            self.registered_checks[check["requirementId"]] = check

        self.recorder.status_changed("plan_ready", "Plan ready for review")
        self.recorder.emit(
            "run.plan_generated", {"plan": plan, "riskSummary": args["risk_summary"]}
        )
        self.plan = plan

        gate_text = "PLAN APPROVAL\n" + "\n".join(
            f"  {s['index']}. [{s['riskLevel']}{'/HW' if s['hardwareAction'] else ''}] {s['title']}"
            for s in plan
        ) + f"\nRisk summary: {args['risk_summary']}\nApprove plan?"
        if not self.approver(gate_text):
            self._stop("Plan rejected")
        self.recorder.status_changed("running", "Plan approved")
        return json.dumps(
            {"status": "approved", "note": "Plan approved by the user. Execution tools are now bound."}
        )

    # -------------------------------------------------------- execute phase
    async def _execute_phase(self) -> None:
        self.mcp = await self.toolhost_factory()
        tools = meta_tools_as_openai() + workspace_tools_as_openai()
        if self.mcp is not None:
            tools += self.mcp.tool_specs
        idle = 0
        while not self.recorder.sealed:
            turn = await self._complete(tools)
            if turn is None:
                continue
            if turn.content:
                self.narration.append(turn.content)
            if not turn.tool_calls:
                idle += 1
                if idle >= MAX_IDLE_TURNS:
                    raise BoundsExceeded("agent stalled: no tool calls for 3 consecutive turns")
                self.messages.append(
                    {
                        "role": "user",
                        "content": "No tool call received. Continue with tools; finish with write_report.",
                    }
                )
                continue
            idle = 0
            for call in turn.tool_calls:
                if self.recorder.sealed:
                    self._respond(call, json.dumps({"error": "run already ended"}))
                    continue
                self._respond(call, await self._dispatch(call))

    async def _dispatch(self, call: ToolCall) -> str:
        args = dict(call.arguments)
        plan_index = args.pop("_plan_index", None)
        if isinstance(plan_index, int) and self.plan and 0 <= plan_index < len(self.plan):
            self.current_plan_index = plan_index

        if call.name in META_TOOL_NAMES:
            return self._handle_meta(call.name, args)
        if call.name in WORKSPACE_TOOL_NAMES:
            return self._handle_workspace(call.name, args)
        if self.mcp is not None and self.mcp.has_tool(call.name):
            return await self._handle_mcp(call.name, args)
        return json.dumps({"error": f"unknown tool {call.name}"})

    # ------------------------------------------------------------ meta tools
    def _handle_meta(self, name: str, args: dict[str, Any]) -> str:
        if name == "declare_plan":
            return json.dumps({"error": "plan already declared"})
        errors = self._schema_errors(name, args)
        if errors:
            return self._meta_failure(name, errors)
        if name == "record_check":
            return self._handle_record_check(args)
        if name == "declare_diagnosis":
            return self._handle_declare_diagnosis(args)
        if name == "declare_iteration":
            return self._handle_declare_iteration(args)
        if name == "write_report":
            return self._handle_write_report(args)
        raise AssertionError(f"unhandled meta tool {name}")

    def _handle_record_check(self, args: dict[str, Any]) -> str:
        req = args["requirementId"]
        registration = self.registered_checks.get(req)
        if registration is None:
            return self._meta_failure(
                "record_check",
                [f"requirementId {req!r} was not registered in declare_plan; "
                 f"registered: {sorted(self.registered_checks)}"],
            )
        if not self.recorder.has_artifact(args["artifactId"]):
            return self._meta_failure(
                "record_check",
                [f"evidence law: artifactId {args['artifactId']!r} does not exist in this run"],
            )
        check: dict[str, Any] = {
            "id": f"chk_{req}",
            "runId": self.cfg.run_id,
            "requirementId": req,
            "description": registration["description"],
            "measurement": registration["measurement"],
            "expected": registration["expected"],
            "actual": args["actual"],
            "verdict": args["verdict"],
            "artifactId": args["artifactId"],
        }
        if args.get("sourceRef"):
            check["sourceRef"] = args["sourceRef"]
        if args.get("sourceDoc"):
            check["sourceDoc"] = args["sourceDoc"]
        defects = validate_definition(self.recorder.repo_root, "MeasurementCheck", check)
        if defects:
            return self._meta_failure("record_check", defects)
        self.recorder.emit("check.evaluated", {"check": check})
        self.check_verdicts[req] = args["verdict"]
        return json.dumps({"recorded": True, "checkId": check["id"], "verdict": args["verdict"]})

    def _handle_declare_diagnosis(self, args: dict[str, Any]) -> str:
        failed = {f"chk_{r}" for r, v in self.check_verdicts.items() if v == "fail"}
        if not failed:
            return self._meta_failure(
                "declare_diagnosis", ["no recorded failed checks; diagnosis follows failed checks"]
            )
        normalized = [
            fid if fid.startswith("chk_") else f"chk_{fid}" for fid in args["failedCheckIds"]
        ]
        unknown = [fid for fid in normalized if fid not in failed]
        if unknown:
            return self._meta_failure(
                "declare_diagnosis",
                [f"failedCheckIds {unknown} do not match recorded failing checks {sorted(failed)}"],
            )
        self._diag_counter += 1
        diagnosis = {
            "id": f"diag_{self._diag_counter:03d}",
            "runId": self.cfg.run_id,
            "failedCheckIds": normalized,
            "hypotheses": args["hypotheses"],
            "proposedFix": args["proposedFix"],
        }
        defects = validate_definition(self.recorder.repo_root, "Diagnosis", diagnosis)
        if defects:
            self._diag_counter -= 1
            return self._meta_failure("declare_diagnosis", defects)

        self.recorder.status_changed(
            "diagnosing", f"{len(normalized)} check(s) failed"
        )
        self.recorder.emit("diagnosis.created", {"diagnosis": diagnosis})

        fix = args["proposedFix"]
        approval_id = self.recorder.next_approval_id()
        self.recorder.status_changed("awaiting_approval", "Fix plan requires approval")
        self.recorder.emit(
            "approval.requested",
            {
                "approval": {
                    "id": approval_id,
                    "runId": self.cfg.run_id,
                    "proposal": {
                        "title": f"Apply fix: {fix['summary'][:120]}",
                        "reason": fix["summary"],
                        "riskLevel": fix["riskLevel"],
                        "filesChanged": fix["filesChanged"],
                        "hardwareActions": [],
                    },
                    "status": "pending",
                }
            },
        )
        approved = self.approver(f"FIX APPROVAL\n{fix['summary']}\nApprove fix?")
        self.recorder.emit(
            "approval.resolved",
            {
                "approvalId": approval_id,
                "status": "approved" if approved else "rejected",
                "resolvedAt": iso_now(),
            },
        )
        if not approved:
            self._stop("Fix rejected")
        self.recorder.status_changed("running", "Fix approved")
        return json.dumps({"diagnosisId": diagnosis["id"], "fixApproval": "approved"})

    def _handle_declare_iteration(self, args: dict[str, Any]) -> str:
        nxt = self.iteration + 1
        if nxt > self.cfg.max_iterations:
            raise BoundsExceeded(
                f"iteration bound exceeded: declare_iteration would start iteration {nxt} "
                f"but maxIterations is {self.cfg.max_iterations}"
            )
        self.iteration = nxt
        self.recorder.emit(
            "run.iteration_started", {"iteration": nxt, "reason": args["reason"]}
        )
        return json.dumps({"iteration": nxt})

    def _handle_write_report(self, args: dict[str, Any]) -> str:
        unresolved = sorted(set(self.registered_checks) - set(self.check_verdicts))
        failing = sorted(r for r, v in self.check_verdicts.items() if v != "pass")
        if unresolved and not self.report_warned:
            self.report_warned = True
            return json.dumps(
                {
                    "error": (
                        f"checks never recorded: {unresolved}. Record them with record_check, "
                        "or call write_report again to end the run as honestly failed."
                    )
                }
            )
        report_artifact_id = self._emit_report_step(args["markdown"])
        summary = _summary_from_markdown(args["markdown"])
        if not unresolved and not failing:
            self.recorder.emit(
                "run.completed", {"summary": summary, "reportArtifactId": report_artifact_id}
            )
        else:
            detail = []
            if failing:
                detail.append(f"failed checks: {', '.join(failing)}")
            if unresolved:
                detail.append(f"unrecorded checks: {', '.join(unresolved)}")
            self.recorder.emit(
                "run.failed", {"summary": f"{summary} ({'; '.join(detail)})"}
            )
        return json.dumps({"reportArtifactId": report_artifact_id, "runEnded": True})

    def _emit_report_step(self, markdown: str) -> str:
        step_id = self._start_step("report", "Generate validation report")
        artifact_id = self.recorder.add_artifact(
            kind="report_md",
            label="Validation report",
            step_id=step_id,
            content=markdown.encode(),
        )
        self.recorder.emit(
            "step.completed",
            {"stepId": step_id, "summary": "Validation report written.", "artifactIds": [artifact_id]},
        )
        return artifact_id

    # -------------------------------------------------------- workspace tools
    def _handle_workspace(self, name: str, args: dict[str, Any]) -> str:
        kind = kind_for_tool(name)
        title = {
            "list_files": "List repo files",
            "read_file": f"Read {args.get('path', '?')}",
            "write_file": f"Edit {args.get('path', '?')}",
        }[name]
        step_id = self._start_step(kind, title)
        try:
            outcome = self.workspace.dispatch(name, args)
        except (WorkspaceError, KeyError) as exc:
            self.recorder.emit(
                "step.failed", {"stepId": step_id, "summary": str(exc), "artifactIds": []}
            )
            return json.dumps({"error": str(exc)})

        artifact_ids: list[str] = []
        if name == "write_file":
            artifact_ids.append(
                self.recorder.add_artifact(
                    kind="code_diff",
                    label=f"Code diff — {args['path']}",
                    step_id=step_id,
                    content=diff_artifact_bytes(outcome["code_diff"]),
                )
            )
            summary = f"Edited {args['path']}: {args['reason']}"
            model_result: dict[str, Any] = {**outcome["result"], "artifactIds": artifact_ids}
        elif name == "read_file":
            summary = f"Read {args['path']}"
            model_result = outcome
        else:
            summary = "Listed repo files"
            model_result = outcome
        self.recorder.emit(
            "step.completed", {"stepId": step_id, "summary": summary, "artifactIds": artifact_ids}
        )
        return _cap(json.dumps(model_result))

    # -------------------------------------------------------------- MCP tools
    async def _handle_mcp(self, name: str, args: dict[str, Any]) -> str:
        assert self.mcp is not None
        description = self.mcp.descriptions.get(name, "")
        if is_risk_gated(name, description):
            refusal = self._gate(name, args)
            if refusal is not None:
                return refusal

        kind = kind_for_tool(name)
        step_id = self._start_step(kind, _humanize(name, args))
        stream = stream_for_kind(kind)
        try:
            result = await self.mcp.call(name, args)
        except Exception as exc:  # noqa: BLE001 — transport failure = visible step failure
            self.recorder.emit(
                "step.log",
                {"stepId": step_id, "stream": "agent", "line": f"MCP error: {exc}"},
            )
            self.recorder.emit(
                "step.failed",
                {"stepId": step_id, "summary": f"{name} failed: {exc}", "artifactIds": []},
            )
            return json.dumps({"error": f"{name} failed: {exc}"})

        log_lines = _log_lines_from_result(result)
        if log_lines:
            self.recorder.emit(
                "step.log", {"stepId": step_id, "stream": stream, "lines": log_lines[:50]}
            )
        artifact_ids = self._artifacts_from_result(name, step_id, result)

        verdict = str(result.get("verdict", "pass"))
        summary = _result_summary(name, result)
        outcome_event = "step.failed" if verdict in ("fail", "error") else "step.completed"
        self.recorder.emit(
            outcome_event, {"stepId": step_id, "summary": summary, "artifactIds": artifact_ids}
        )
        payload = {"result": result, "artifactIds": artifact_ids}
        return _cap(json.dumps(payload, default=str))

    def _gate(self, name: str, args: dict[str, Any]) -> str | None:
        """Park before the MCP call. Returns a refusal result on rejection."""
        approval_id = self.recorder.next_approval_id()
        short_args = {k: v for k, v in args.items() if isinstance(v, (str, int, float, bool))}
        proposal = {
            "title": f"Hardware action: {name}",
            "reason": (self.narration[-1][:300] if self.narration else f"Agent requested {name}."),
            "riskLevel": risk_level_for(name),
            "filesChanged": list(self.workspace.edited_since_gate),
            "hardwareActions": [f"{name}({json.dumps(short_args, default=str)[:200]})"],
        }
        self.recorder.status_changed("awaiting_approval", f"{name} requires approval")
        self.recorder.emit(
            "approval.requested",
            {
                "approval": {
                    "id": approval_id,
                    "runId": self.cfg.run_id,
                    "proposal": proposal,
                    "status": "pending",
                }
            },
        )
        approved = self.approver(
            f"HARDWARE APPROVAL\n{proposal['title']}\nargs: {json.dumps(short_args, default=str)}\nApprove?"
        )
        self.recorder.emit(
            "approval.resolved",
            {
                "approvalId": approval_id,
                "status": "approved" if approved else "rejected",
                "resolvedAt": iso_now(),
            },
        )
        if not approved:
            self._stop(f"{name} rejected")
        self.recorder.status_changed("running", f"{name} approved")
        self.workspace.edited_since_gate.clear()
        return None

    def _artifacts_from_result(
        self, name: str, step_id: str, result: dict[str, Any]
    ) -> list[str]:
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        ids: list[str] = []
        if name == "build_firmware":
            text = _build_log_text(result)
            ids.append(
                self.recorder.add_artifact(
                    kind="build_log", label="Build log", step_id=step_id, content=text.encode()
                )
            )
        elif name == "flash_firmware":
            ids.append(
                self.recorder.add_artifact(
                    kind="flash_log",
                    label="Flash log",
                    step_id=step_id,
                    content=json.dumps(result, indent=2, default=str).encode(),
                )
            )
        elif name in ("decode_bus", "capture_during") and "annotations" in data:
            ids.append(
                self.recorder.add_artifact(
                    kind="protocol_decode",
                    label=f"Protocol decode ({data.get('protocol', 'bus')})",
                    step_id=step_id,
                    content=json.dumps(data, indent=2, default=str).encode(),
                )
            )
        elif isinstance(data.get("text"), str) and data["text"].strip() and name in _KIND_RTT:
            ids.append(
                self.recorder.add_artifact(
                    kind="serial_log", label="RTT log", step_id=step_id, content=data["text"].encode()
                )
            )
        return ids

    # ------------------------------------------------------------- plumbing
    async def _complete(self, tools: list[dict[str, Any]]) -> ModelTurn | None:
        if self.turns >= self.cfg.max_turns:
            raise BoundsExceeded(f"turn bound exceeded: max_turns={self.cfg.max_turns}")
        self.turns += 1
        try:
            turn = await self.provider.complete(self.messages, tools)
        except MalformedToolArguments as exc:
            self.messages.append(
                {
                    "role": "user",
                    "content": f"Your {exc.tool_name} call carried invalid JSON arguments: {exc}. Retry.",
                }
            )
            self._count_failure(exc.tool_name)
            return None
        self.messages.append(turn.raw_message)
        return turn

    def _respond(self, call: ToolCall, content: str) -> None:
        self.messages.append({"role": "tool", "tool_call_id": call.id, "content": content})

    def _start_step(self, kind: str, title: str) -> str:
        step_id = self.recorder.next_step_id(kind)
        self.recorder.emit(
            "step.started",
            {
                "step": {
                    "id": step_id,
                    "runId": self.cfg.run_id,
                    "planIndex": self.current_plan_index,
                    "kind": kind,
                    "status": "active",
                    "title": title,
                    "startedAt": iso_now(),
                    "artifactIds": [],
                }
            },
        )
        if self.narration:
            lines = [ln for chunk in self.narration for ln in chunk.splitlines() if ln.strip()]
            if lines:
                self.recorder.emit(
                    "step.log", {"stepId": step_id, "stream": "agent", "lines": lines[:30]}
                )
            self.narration.clear()
        return step_id

    def _schema_errors(self, name: str, args: dict[str, Any]) -> list[str]:
        validator = jsonschema.Draft7Validator(META_TOOL_SCHEMAS[name]["parameters"])
        return [
            f"{'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}"
            for e in sorted(validator.iter_errors(args), key=str)
        ]

    def _meta_failure(self, name: str, errors: list[str]) -> str:
        self._count_failure(name)
        return json.dumps(
            {
                "error": f"{name} payload rejected",
                "schema_errors": errors[:5],
                "note": "One retry: fix the payload and call again. A second malformed payload aborts the run.",
            }
        )

    def _count_failure(self, name: str) -> None:
        self.meta_failures[name] = self.meta_failures.get(name, 0) + 1
        if self.meta_failures[name] >= 2:
            raise MetaToolAbort(f"{name} payload malformed twice")

    def _stop(self, reason: str) -> None:
        self.recorder.status_changed("stopped", reason)
        self.recorder.emit("run.stopped", {"byUser": True})
        raise RunStopped(reason)

    async def _fail_with_partial_report(self, reason: str) -> None:
        """Bounds hit (spec §3.3/3.4): graceful run.failed with a report attempt."""
        summary = f"Run terminated by harness: {reason}"
        report_id: str | None = None
        try:
            self.messages.append(
                {
                    "role": "user",
                    "content": (
                        f"HARNESS: {reason}. The run is being terminated. "
                        "Call write_report once, now, with an honest partial report."
                    ),
                }
            )
            report_tool = [t for t in meta_tools_as_openai() if t["function"]["name"] == "write_report"]
            turn = await self.provider.complete(self.messages, report_tool)
            for call in turn.tool_calls:
                if call.name == "write_report" and isinstance(call.arguments.get("markdown"), str):
                    report_id = self._emit_report_step(call.arguments["markdown"])
                    break
        except Exception:  # noqa: BLE001 — the partial report is best-effort
            pass
        if not self.recorder.sealed:
            if report_id:
                summary += " (partial report attached)"
            self.recorder.emit("run.failed", {"summary": summary})


# ------------------------------------------------------------------ helpers
def _cap(text: str) -> str:
    if len(text) <= TOOL_RESULT_CAP:
        return text
    return text[:TOOL_RESULT_CAP] + f"... [truncated {len(text) - TOOL_RESULT_CAP} chars]"


def _humanize(name: str, args: dict[str, Any]) -> str:
    label = name.replace("_", " ").capitalize()
    for key in ("project_dir", "firmware_path", "peripheral", "pattern", "protocol"):
        if isinstance(args.get(key), str):
            return f"{label} — {Path(str(args[key])).name if '/' in str(args[key]) else args[key]}"
    return label


def _log_lines_from_result(result: dict[str, Any]) -> list[str]:
    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    for key in ("stdout", "text", "output", "log"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.splitlines()
    compact = json.dumps(result, default=str)
    return [compact[:400]]


def _build_log_text(result: dict[str, Any]) -> str:
    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    parts = []
    for key in ("command", "stdout", "stderr"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value if key != "command" else f"$ {value}")
    return "\n".join(parts) if parts else json.dumps(result, indent=2, default=str)


def _result_summary(name: str, result: dict[str, Any]) -> str:
    verdict = result.get("verdict", "pass")
    message = result.get("message") or result.get("error") or ""
    if isinstance(message, dict):
        message = json.dumps(message, default=str)
    text = f"{name}: {verdict}"
    if message:
        text += f" — {str(message)[:200]}"
    return text


def _summary_from_markdown(markdown: str) -> str:
    for line in markdown.splitlines():
        stripped = line.strip().lstrip("#").strip()
        if stripped:
            return stripped[:300]
    return "Report written."
