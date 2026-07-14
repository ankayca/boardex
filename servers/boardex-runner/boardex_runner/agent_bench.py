"""The agent bench: RUNNER_AGENT_V0_SPEC v0, married to the run engine.

``AgentRunEngine`` replaces the scripted ``_pipeline``/``_iteration`` storyboard
with an LLM tool-use loop while reusing the engine's wire layer untouched: the
EventLog (append-path schema validation), the ArtifactStore, the plan/approval
gate futures (HTTP-driven), stop sealing, and the RECORD tee. ``AgentBench`` is
the per-run configuration + resource carrier — one instance per run, never a
process-wide singleton (RUNNER_AUDIT_2026-07-13 HIGH-1).

Safety invariants are harness-enforced, never prompt-enforced (spec §3):
interception with the hardcoded gate floor parks BEFORE the MCP invocation;
stop cancels the agent task at the next await; turn/iteration/stall bounds are
harness counters; malformed meta-tool payloads get one retry then abort the
run as failed; the MCP servers are not even spawned before plan approval.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Awaitable, Callable

import jsonschema

from .bench import ApprovalSpec
from .contract import CONTRACT_VERSION, definition_errors, schema_dir
from .engine import Conflict, RunEngine
from .events import RunTerminated
from .interception import is_risk_gated, risk_level_for
from .mcp_host import McpHostError, McpToolHost, ToolHost
from .meta_tools import META_TOOL_NAMES, META_TOOL_SCHEMAS, meta_tools_as_openai
from .prompts import BENCH_NOTE_DEFAULT, SYSTEM_PROMPT, plan_phase_user_message
from .provider import DEFAULT_MODEL, LiteLLMProvider, MalformedToolArguments, ModelTurn, ToolCall
from .workspace import (
    WORKSPACE_TOOL_NAMES,
    Workspace,
    WorkspaceError,
    workspace_tools_as_openai,
)

TOOL_RESULT_CAP = 16_000
MAX_IDLE_TURNS = 3  # consecutive assistant turns with no tool call
DEFAULT_MAX_TURNS = 40
PROTOCOL_DECODE_FIELDS = {
    "protocol",
    "device_id",
    "channel_map",
    "sample_rate_hz",
    "num_samples",
    "duration_s",
    "bus_state",
    "trigger_channel",
    "trigger_edge",
    "annotations",
    "transactions",
}


class BoundsExceeded(Exception):
    """A harness bound (turns, iterations, stall) was hit — graceful run.failed."""


class MetaToolAbort(Exception):
    """A meta-tool payload was malformed twice — fail closed, abort the run."""


def agent_models_from_env() -> list[str]:
    """AGENT_MODELS: comma-separated LiteLLM model strings for capabilities.models."""
    raw = os.environ.get("AGENT_MODELS", DEFAULT_MODEL)
    models = [model.strip() for model in raw.split(",") if model.strip()]
    if not models:
        raise SystemExit("AGENT_MODELS must name at least one LiteLLM model string")
    return models


def agent_bench_status() -> dict[str, Any]:
    """Static snapshot: the agent bench holds no device handles of its own —
    hardware lives behind the MCP servers, which are spawned per run after
    plan approval, so there is nothing to scan here (and nothing that could
    block the event loop, audit HIGH-2)."""
    return {"runnerOnline": True, "contractVersion": CONTRACT_VERSION, "devices": []}


def _default_venv_root() -> Path:
    # schema_dir() = <checkout>/packages/contract/json-schema; the MCP server
    # binaries live in <checkout>/.venv/bin (same invocation as .cursor/mcp.json).
    return schema_dir().parents[2]


class AgentBench:
    """Per-run agent-bench configuration and resource lifecycle."""

    blocking = False  # the loop is natively async; no executor stages here
    # Per-run AgentBench instances are fresh, but each spawns MCP servers that
    # drive the ONE physical probe + analyzer: concurrent runs would collide on
    # the shared hardware underneath (audit HIGH-1), so the bench is exclusive.
    exclusive = True

    def __init__(
        self,
        *,
        max_turns: int = DEFAULT_MAX_TURNS,
        provider_factory: Callable[[str], Any] = LiteLLMProvider,
        toolhost_factory: Callable[[], Awaitable[ToolHost | None]] | None = None,
        venv_root: Path | None = None,
    ) -> None:
        self.max_turns = max_turns
        self.provider_factory = provider_factory
        self._toolhost_factory = toolhost_factory
        self.venv_root = venv_root
        self.halted = False

    def bench_status(self) -> dict[str, Any]:
        return agent_bench_status()

    async def connect_tools(self) -> ToolHost | None:
        """Bind the MCP servers (execute phase only — spec §2). Returns None
        when the bench tool layer is unavailable: the run degrades to
        workspace + meta tools instead of dying at the plan gate."""
        if self._toolhost_factory is not None:
            return await self._toolhost_factory()
        host = McpToolHost()
        try:
            await host.connect(self.venv_root or _default_venv_root())
        except McpHostError:
            try:
                await host.close()
            except Exception:
                pass
            return None
        return host

    def halt(self) -> None:
        """Hardware sessions live inside the per-run MCP server subprocesses;
        stop cancels the agent task, whose unwind closes the stdio host (and
        with it the servers and their sessions) in-task."""
        self.halted = True


class AgentRunEngine(RunEngine):
    """RunEngine whose pipeline is the agent loop instead of the scripted arc."""

    bench: AgentBench

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._provider = self.bench.provider_factory(self.model or DEFAULT_MODEL)
        self._max_turns = self.bench.max_turns
        self._max_iterations = int(self.profile.get("safety", {}).get("maxIterations", 3))
        self._messages: list[dict[str, Any]] = []
        self._turns = 0
        self._plan: list[dict[str, Any]] | None = None
        self._plan_index = 0
        self._registered_checks: dict[str, dict[str, Any]] = {}
        self._check_verdicts: dict[str, str] = {}
        self._meta_failures: dict[str, int] = {}
        self._narration: list[str] = []
        self._report_warned = False
        self._mcp: ToolHost | None = None
        self._workspace: Workspace | None = None
        self._artifact_n = 0
        self._diag_n = 0
        self._run_artifact_ids: set[str] = set()

    # -- public: server-facing ----------------------------------------------------

    def stop(self) -> Conflict | None:
        """Stop is a hard cancel (spec §3.2): seal the log first (base emits the
        terminal pair), then cancel the agent task at its next await point —
        never "after the current turn finishes"."""
        conflict = super().stop()
        if conflict is None and self.task is not None and not self.task.done():
            self.task.cancel()
        return conflict

    # -- the pipeline ----------------------------------------------------------------

    async def _pipeline(self) -> None:
        self.status = "planning"
        self._emit("run.created", {"run": self._run_entity("planning")})
        try:
            self._workspace = Workspace(Path(str(self.profile.get("repoPath", ""))))
        except WorkspaceError as exc:
            self._emit("run.failed", {"summary": f"Agent bench cannot start: {exc}"})
            self.status = "failed"
            return
        try:
            await self._plan_phase()
            self._mcp = await self.bench.connect_tools()
            if self._mcp is None:
                self._messages.append(
                    {
                        "role": "user",
                        "content": (
                            "HARNESS: the bench MCP servers are unavailable; hardware "
                            "tools are NOT bound. Proceed with the workspace and meta "
                            "tools only, and record honestly what could not be measured."
                        ),
                    }
                )
            await self._execute_phase()
        except BoundsExceeded as exc:
            await self._fail_with_partial_report(str(exc))
        except MetaToolAbort as exc:
            if not self.log.sealed:
                self._emit("run.failed", {"summary": f"Aborted (fail closed): {exc}"})
                self.status = "failed"
        finally:
            await self._close_mcp()

    async def _close_mcp(self) -> None:
        host, self._mcp = self._mcp, None
        if host is None:
            return
        try:
            await host.close()
        except Exception:
            pass

    # -- plan phase ---------------------------------------------------------------

    async def _plan_phase(self) -> None:
        assert self._workspace is not None
        self._messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": plan_phase_user_message(
                    self.task_prompt,
                    str(self._workspace.repo),
                    self._workspace.tree_snapshot(),
                    self._bench_note(),
                ),
            },
        ]
        idle = 0
        while self._plan is None:
            turn = await self._complete(meta_tools_as_openai())
            if turn is None:
                continue
            if turn.content:
                self._narration.append(turn.content)
            if not turn.tool_calls:
                idle += 1
                if idle >= MAX_IDLE_TURNS:
                    raise MetaToolAbort("agent never called declare_plan in the plan phase")
                self._messages.append(
                    {"role": "user", "content": "You must call declare_plan to proceed."}
                )
                continue
            for call in turn.tool_calls:
                if self._plan is None and call.name == "declare_plan":
                    self._respond(call, await self._handle_declare_plan(call))
                else:
                    self._respond(
                        call,
                        json.dumps({"error": "Only declare_plan is valid during the plan phase."}),
                    )

    def _bench_note(self) -> str:
        # Document bodies are served by reference (§5.3); only metadata rides here.
        profile = {key: value for key, value in self.profile.items() if key != "documents"}
        return (
            BENCH_NOTE_DEFAULT
            + "\n## Board profile\n```json\n"
            + json.dumps(profile, indent=2)
            + "\n```"
        )

    async def _handle_declare_plan(self, call: ToolCall) -> str:
        args = dict(call.arguments)
        args.pop("_plan_index", None)
        errors = self._schema_errors("declare_plan", args)
        if errors:
            return self._meta_failure("declare_plan", errors)
        plan = [
            {
                "index": i,
                "title": step["title"],
                "detail": step["detail"],
                "riskLevel": step["riskLevel"],
                "hardwareAction": step["hardwareAction"],
            }
            for i, step in enumerate(args["steps"])
        ]
        for step in plan:
            defects = definition_errors("PlanStep", step)
            if defects:
                return self._meta_failure("declare_plan", defects)
        for check in args["checks"]:
            self._registered_checks[check["requirementId"]] = check

        # §5.7 rule 2: report plan_ready BEFORE blocking on plan approval.
        self._transition("plan_ready", "Plan ready for review")
        self._emit(
            "run.plan_generated", {"plan": plan, "riskSummary": args["risk_summary"]}
        )
        self._plan = plan
        await self._wait_gate("plan")  # released by POST /runs/{id}/plan/approve
        self._transition("running", "Plan approved")
        return json.dumps(
            {"status": "approved", "note": "Plan approved by the user. Execution tools are now bound."}
        )

    # -- execute phase --------------------------------------------------------------

    async def _execute_phase(self) -> None:
        tools = meta_tools_as_openai() + workspace_tools_as_openai()
        if self._mcp is not None:
            tools = tools + self._mcp.tool_specs
        idle = 0
        while not self.log.sealed:
            turn = await self._complete(tools)
            if turn is None:
                continue
            if turn.content:
                self._narration.append(turn.content)
            if not turn.tool_calls:
                idle += 1
                if idle >= MAX_IDLE_TURNS:
                    raise BoundsExceeded("agent stalled: no tool calls for 3 consecutive turns")
                self._messages.append(
                    {
                        "role": "user",
                        "content": "No tool call received. Continue with tools; finish with write_report.",
                    }
                )
                continue
            idle = 0
            for call in turn.tool_calls:
                if self.log.sealed:
                    self._respond(call, json.dumps({"error": "run already ended"}))
                    continue
                self._respond(call, await self._dispatch(call))

    async def _dispatch(self, call: ToolCall) -> str:
        args = dict(call.arguments)
        plan_index = args.pop("_plan_index", None)  # harness-only; never crosses to MCP
        if isinstance(plan_index, int) and self._plan and 0 <= plan_index < len(self._plan):
            self._plan_index = plan_index

        if call.name in META_TOOL_NAMES:
            return await self._handle_meta(call.name, args)
        if call.name in WORKSPACE_TOOL_NAMES:
            return self._handle_workspace(call.name, args)
        if self._mcp is not None and self._mcp.has_tool(call.name):
            return await self._handle_mcp(call.name, args)
        return json.dumps({"error": f"unknown tool {call.name}"})

    # -- meta tools -------------------------------------------------------------------

    async def _handle_meta(self, name: str, args: dict[str, Any]) -> str:
        if name == "declare_plan":
            return json.dumps({"error": "plan already declared"})
        errors = self._schema_errors(name, args)
        if errors:
            return self._meta_failure(name, errors)
        if name == "record_check":
            return self._handle_record_check(args)
        if name == "declare_diagnosis":
            return await self._handle_declare_diagnosis(args)
        if name == "declare_iteration":
            return self._handle_declare_iteration(args)
        if name == "write_report":
            return self._handle_write_report(args)
        raise AssertionError(f"unhandled meta tool {name}")

    def _handle_record_check(self, args: dict[str, Any]) -> str:
        req = args["requirementId"]
        registration = self._registered_checks.get(req)
        if registration is None:
            return self._meta_failure(
                "record_check",
                [f"requirementId {req!r} was not registered in declare_plan; "
                 f"registered: {sorted(self._registered_checks)}"],
            )
        if args["artifactId"] not in self._run_artifact_ids:
            return self._meta_failure(
                "record_check",
                [f"evidence law: artifactId {args['artifactId']!r} does not exist in this run"],
            )
        check: dict[str, Any] = {
            "id": f"chk_{req}",
            "runId": self.id,
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
        defects = definition_errors("MeasurementCheck", check)
        if defects:
            return self._meta_failure("record_check", defects)
        self._emit("check.evaluated", {"check": check})
        self._check_verdicts[req] = args["verdict"]
        return json.dumps({"recorded": True, "checkId": check["id"], "verdict": args["verdict"]})

    async def _handle_declare_diagnosis(self, args: dict[str, Any]) -> str:
        failed = {f"chk_{req}" for req, verdict in self._check_verdicts.items() if verdict == "fail"}
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
        self._diag_n += 1
        diagnosis = {
            "id": f"diag_{self._suffix}_{self._diag_n:03d}",
            "runId": self.id,
            "failedCheckIds": normalized,
            "hypotheses": args["hypotheses"],
            "proposedFix": args["proposedFix"],
        }
        defects = definition_errors("Diagnosis", diagnosis)
        if defects:
            self._diag_n -= 1
            return self._meta_failure("declare_diagnosis", defects)

        self._transition("diagnosing", f"{len(normalized)} check(s) failed")
        self._emit("diagnosis.created", {"diagnosis": diagnosis})

        fix = args["proposedFix"]
        approved = await self._approval_gate(
            ApprovalSpec(
                title=f"Apply fix: {fix['summary'][:120]}",
                reason=fix["summary"],
                risk_level=fix["riskLevel"],
                files_changed=fix["filesChanged"],
                hardware_actions=[],
                status_reason="Fix plan requires approval",
            )
        )
        if not approved:
            raise RunTerminated(self.id)
        self._transition("running", "Fix approved")
        return json.dumps({"diagnosisId": diagnosis["id"], "fixApproval": "approved"})

    def _handle_declare_iteration(self, args: dict[str, Any]) -> str:
        nxt = self.iteration + 1
        if nxt > self._max_iterations:
            raise BoundsExceeded(
                f"iteration bound exceeded: declare_iteration would start iteration {nxt} "
                f"but maxIterations is {self._max_iterations}"
            )
        self.iteration = nxt
        self._emit("run.iteration_started", {"iteration": nxt, "reason": args["reason"]})
        return json.dumps({"iteration": nxt})

    def _handle_write_report(self, args: dict[str, Any]) -> str:
        unresolved = sorted(set(self._registered_checks) - set(self._check_verdicts))
        failing = sorted(req for req, verdict in self._check_verdicts.items() if verdict != "pass")
        if unresolved and not self._report_warned:
            self._report_warned = True
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
            self._emit(
                "run.completed", {"summary": summary, "reportArtifactId": report_artifact_id}
            )
            self.status = "completed"
        else:
            detail = []
            if failing:
                detail.append(f"failed checks: {', '.join(failing)}")
            if unresolved:
                detail.append(f"unrecorded checks: {', '.join(unresolved)}")
            self._emit("run.failed", {"summary": f"{summary} ({'; '.join(detail)})"})
            self.status = "failed"
        return json.dumps({"reportArtifactId": report_artifact_id, "runEnded": True})

    def _emit_report_step(self, markdown: str) -> str:
        step_id = self._start_step("report", "Generate validation report")
        artifact_id = self._add_artifact(
            kind="report_md",
            label="Validation report",
            step_id=step_id,
            content=markdown.encode(),
        )
        self._emit(
            "step.completed",
            {"stepId": step_id, "summary": "Validation report written.", "artifactIds": [artifact_id]},
        )
        return artifact_id

    # -- workspace tools ---------------------------------------------------------------

    def _handle_workspace(self, name: str, args: dict[str, Any]) -> str:
        assert self._workspace is not None
        kind = _kind_for_tool(name)
        title = {
            "list_files": "List repo files",
            "read_file": f"Read {args.get('path', '?')}",
            "write_file": f"Edit {args.get('path', '?')}",
        }[name]
        step_id = self._start_step(kind, title)
        try:
            outcome = self._workspace.dispatch(name, args)
        except (WorkspaceError, KeyError) as exc:
            self._emit(
                "step.failed", {"stepId": step_id, "summary": str(exc), "artifactIds": []}
            )
            return json.dumps({"error": str(exc)})

        artifact_ids: list[str] = []
        if name == "write_file":
            artifact_ids.append(
                self._add_artifact(
                    kind="code_diff",
                    label=f"Code diff — {args['path']}",
                    step_id=step_id,
                    content=outcome["code_diff"],
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
        self._emit(
            "step.completed", {"stepId": step_id, "summary": summary, "artifactIds": artifact_ids}
        )
        return _cap(json.dumps(model_result))

    # -- MCP tools ------------------------------------------------------------------------

    async def _handle_mcp(self, name: str, args: dict[str, Any]) -> str:
        assert self._mcp is not None
        description = self._mcp.descriptions.get(name, "")
        if is_risk_gated(name, description):
            await self._gate_tool(name, args)  # raises RunTerminated on rejection

        kind = _kind_for_tool(name)
        step_id = self._start_step(kind, _humanize(name, args))
        stream = _stream_for_kind(kind)
        try:
            result = await self._mcp.call(name, args)
        except Exception as exc:  # transport failure = visible step failure (§3.5)
            self._emit(
                "step.log",
                {"stepId": step_id, "stream": "agent", "line": f"MCP error: {exc}"},
            )
            self._emit(
                "step.failed",
                {"stepId": step_id, "summary": f"{name} failed: {exc}", "artifactIds": []},
            )
            return json.dumps({"error": f"{name} failed: {exc}"})

        log_lines = _log_lines_from_result(result)
        if log_lines:
            self._emit(
                "step.log", {"stepId": step_id, "stream": stream, "lines": log_lines[:50]}
            )
        artifact_ids = self._artifacts_from_result(name, step_id, result)

        verdict = str(result.get("verdict", "pass"))
        summary = _result_summary(name, result)
        outcome_event = "step.failed" if verdict in ("fail", "error") else "step.completed"
        self._emit(
            outcome_event, {"stepId": step_id, "summary": summary, "artifactIds": artifact_ids}
        )
        payload = {"result": result, "artifactIds": artifact_ids}
        return _cap(json.dumps(payload, default=str))

    async def _gate_tool(self, name: str, args: dict[str, Any]) -> None:
        """Park on the engine's approval gate BEFORE the MCP invocation (spec
        §3.1). Rejection ends the run via the gate's stopped path; the tool is
        provably never invoked."""
        assert self._workspace is not None
        short_args = {k: v for k, v in args.items() if isinstance(v, (str, int, float, bool))}
        approved = await self._approval_gate(
            ApprovalSpec(
                title=f"Hardware action: {name}",
                reason=(self._narration[-1][:300] if self._narration else f"Agent requested {name}."),
                risk_level=risk_level_for(name),
                files_changed=list(self._workspace.edited_since_gate),
                hardware_actions=[f"{name}({json.dumps(short_args, default=str)[:200]})"],
                status_reason=f"{name} requires approval",
            )
        )
        if not approved:
            raise RunTerminated(self.id)
        self._transition("running", f"{name} approved")
        self._workspace.edited_since_gate.clear()

    def _artifacts_from_result(
        self, name: str, step_id: str, result: dict[str, Any]
    ) -> list[str]:
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        decode_data = data
        if name == "verify_bringup":
            evidence = data.get("evidence") if isinstance(data.get("evidence"), dict) else {}
            decode_data = (
                evidence.get("i2c") if isinstance(evidence.get("i2c"), dict) else {}
            )
        ids: list[str] = []
        if name == "build_firmware":
            text = _build_log_text(result)
            ids.append(
                self._add_artifact(
                    kind="build_log", label="Build log", step_id=step_id, content=text.encode()
                )
            )
        elif name == "flash_firmware":
            ids.append(
                self._add_artifact(
                    kind="flash_log",
                    label="Flash log",
                    step_id=step_id,
                    content=json.dumps(result, indent=2, default=str).encode(),
                )
            )
        elif name in (
            "decode_bus",
            "capture_during",
            "reset_and_capture_i2c",
            "verify_bringup",
        ) and "annotations" in decode_data:
            protocol_content = {
                key: value
                for key, value in decode_data.items()
                if key in PROTOCOL_DECODE_FIELDS and value is not None
            }
            ids.append(
                self._add_artifact(
                    kind="protocol_decode",
                    label=f"Protocol decode ({decode_data.get('protocol', 'bus')})",
                    step_id=step_id,
                    content=protocol_content,
                )
            )
            frequency = decode_data.get("scl_frequency_hz")
            if isinstance(frequency, (int, float)) and frequency > 0:
                ids.append(
                    self._add_artifact(
                        kind="timing_measurement",
                        label="Measured I2C SCL frequency",
                        step_id=step_id,
                        content={
                            "measurement": "logic_analyzer.i2c.scl_frequency_hz",
                            "valueHz": frequency,
                        },
                    )
                )
        elif isinstance(data.get("text"), str) and data["text"].strip() and name in _KIND_RTT:
            ids.append(
                self._add_artifact(
                    kind="serial_log", label="RTT log", step_id=step_id, content=data["text"].encode()
                )
            )
        return ids

    # -- plumbing ------------------------------------------------------------------------

    async def _complete(self, tools: list[dict[str, Any]]) -> ModelTurn | None:
        if self._turns >= self._max_turns:
            raise BoundsExceeded(f"turn bound exceeded: max_turns={self._max_turns}")
        self._turns += 1
        try:
            turn = await self._provider.complete(self._messages, tools)
        except MalformedToolArguments as exc:
            self._messages.append(
                {
                    "role": "user",
                    "content": f"Your {exc.tool_name} call carried invalid JSON arguments: {exc}. Retry.",
                }
            )
            self._count_failure(exc.tool_name)
            return None
        self._messages.append(turn.raw_message)
        return turn

    def _respond(self, call: ToolCall, content: str) -> None:
        self._messages.append({"role": "tool", "tool_call_id": call.id, "content": content})

    def _start_step(self, kind: str, title: str) -> str:
        # Seq-derived ids: an agent may build/flash N times per iteration, so
        # the scripted engine's st_{kind}_iter{n}_{suffix} scheme would collide.
        step_id = f"st_{kind}_{self._suffix}_{self.log.next_seq}"
        self._emit(
            "step.started",
            {
                "step": {
                    "id": step_id,
                    "runId": self.id,
                    "planIndex": self._plan_index,
                    "kind": kind,
                    "status": "active",
                    "title": title,
                    "startedAt": self.clock.now_iso(),
                    "artifactIds": [],
                }
            },
        )
        if self._narration:
            lines = [ln for chunk in self._narration for ln in chunk.splitlines() if ln.strip()]
            if lines:
                self._emit(
                    "step.log", {"stepId": step_id, "stream": "agent", "lines": lines[:30]}
                )
            self._narration.clear()
        return step_id

    def _add_artifact(
        self, *, kind: str, label: str, step_id: str, content: Any
    ) -> str:
        self._artifact_n += 1
        artifact_id = f"art_{self._suffix}_{self._artifact_n:03d}_{kind}"
        meta = self.artifacts.put(
            artifact_id=artifact_id,
            run_id=self.id,
            step_id=step_id,
            kind=kind,
            label=label,
            content=content,
        )
        self._emit("artifact.created", {"artifact": meta})
        self._run_artifact_ids.add(artifact_id)
        return artifact_id

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
        self._meta_failures[name] = self._meta_failures.get(name, 0) + 1
        if self._meta_failures[name] >= 2:
            raise MetaToolAbort(f"{name} payload malformed twice")

    async def _fail_with_partial_report(self, reason: str) -> None:
        """Bounds hit (spec §3.3/§3.4): graceful run.failed with a report attempt."""
        summary = f"Run terminated by harness: {reason}"
        report_id: str | None = None
        try:
            self._messages.append(
                {
                    "role": "user",
                    "content": (
                        f"HARNESS: {reason}. The run is being terminated. "
                        "Call write_report once, now, with an honest partial report."
                    ),
                }
            )
            report_tool = [
                t for t in meta_tools_as_openai() if t["function"]["name"] == "write_report"
            ]
            turn = await self._provider.complete(self._messages, report_tool)
            for call in turn.tool_calls:
                if call.name == "write_report" and isinstance(call.arguments.get("markdown"), str):
                    report_id = self._emit_report_step(call.arguments["markdown"])
                    break
        except Exception:  # the partial report is best-effort
            pass
        if not self.log.sealed:
            if report_id:
                summary += " (partial report attached)"
            self._emit("run.failed", {"summary": summary})
            self.status = "failed"


# -- tool -> StepKind / log-stream mapping ------------------------------------------------

_KIND_FLASH = {
    "flash_firmware", "reset_target", "recover_target", "write_memory",
    "write_register", "halt_target", "resume_target", "run_checkpoint",
    "verify_bringup",
}
_KIND_CAPTURE = {
    "capture",
    "decode_bus",
    "capture_during",
    "reset_and_capture_i2c",
    "get_capabilities",
}
_KIND_RTT = {
    "read_firmware_log", "read_rtt", "wait_for_rtt", "start_rtt", "stop_rtt",
    "prepare_session", "open_session", "close_session",
}


def _kind_for_tool(name: str) -> str:
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


def _stream_for_kind(kind: str) -> str:
    return _STREAM_BY_KIND.get(kind, "agent")


# -- helpers -------------------------------------------------------------------------------


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
