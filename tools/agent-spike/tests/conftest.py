from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agent_spike.contract import find_repo_root
from agent_spike.loop import Harness, RunConfig
from agent_spike.provider import ModelTurn, ToolCall
from agent_spike.recorder import RunRecorder
from agent_spike.workspace import Workspace

REPO_ROOT = find_repo_root()


def make_turn(content: str | None = None, calls: list[tuple[str, dict[str, Any]]] | None = None) -> ModelTurn:
    tool_calls = []
    raw_calls = []
    for i, (name, args) in enumerate(calls or []):
        raw = json.dumps(args)
        tool_calls.append(ToolCall(id=f"call_{name}_{i}", name=name, arguments=args, raw_arguments=raw))
        raw_calls.append(
            {
                "id": f"call_{name}_{i}",
                "type": "function",
                "function": {"name": name, "arguments": raw},
            }
        )
    raw_message: dict[str, Any] = {"role": "assistant", "content": content}
    if raw_calls:
        raw_message["tool_calls"] = raw_calls
    return ModelTurn(content=content, tool_calls=tool_calls, raw_message=raw_message)


class FakeProvider:
    """Scripted provider. `script` turns are served in order; when exhausted the
    `filler` turn repeats. When asked for a completion with only write_report
    bound (the harness's partial-report attempt), `report_turn` is served."""

    def __init__(
        self,
        script: list[ModelTurn],
        filler: ModelTurn | None = None,
        report_turn: ModelTurn | None = None,
    ) -> None:
        self.script = list(script)
        self.filler = filler
        self.report_turn = report_turn
        self.calls = 0

    async def complete(self, messages, tools):  # noqa: ANN001
        self.calls += 1
        names = [t["function"]["name"] for t in tools]
        if names == ["write_report"] and self.report_turn is not None:
            return self.report_turn
        if self.script:
            return self.script.pop(0)
        if self.filler is not None:
            return self.filler
        raise AssertionError("FakeProvider script exhausted")


class FakeToolHost:
    def __init__(self, tools: dict[str, str], results: dict[str, dict[str, Any]] | None = None) -> None:
        self.descriptions = dict(tools)
        self.tool_specs = [
            {
                "type": "function",
                "function": {"name": name, "description": desc, "parameters": {"type": "object", "properties": {}}},
            }
            for name, desc in tools.items()
        ]
        self.results = results or {}
        self.invocations: list[tuple[str, dict[str, Any]]] = []

    def has_tool(self, name: str) -> bool:
        return name in self.descriptions

    async def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        self.invocations.append((name, args))
        return self.results.get(name, {"verdict": "pass", "data": {}})


class ScriptedApprover:
    def __init__(self, answers: list[bool]) -> None:
        self.answers = list(answers)
        self.prompts: list[str] = []

    def __call__(self, prompt: str) -> bool:
        self.prompts.append(prompt)
        if not self.answers:
            raise AssertionError("approver asked more times than scripted")
        return self.answers.pop(0)


VALID_PLAN_ARGS: dict[str, Any] = {
    "steps": [
        {"title": "Understand", "detail": "Read the repo", "riskLevel": "low", "hardwareAction": False},
        {"title": "Do the thing", "detail": "Edit and build", "riskLevel": "medium", "hardwareAction": True},
    ],
    "risk_summary": "One gated hardware action.",
    "checks": [
        {
            "requirementId": "build_ok",
            "description": "Firmware must build",
            "measurement": "build.exit_code",
            "expected": {"equals": "0"},
        }
    ],
}


def read_events(record_dir: Path) -> list[dict[str, Any]]:
    lines = (record_dir / "recorded_run.jsonl").read_text().strip().splitlines()
    return [json.loads(line) for line in lines]


@pytest.fixture
def task_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "task-repo"
    repo.mkdir()
    (repo / "main.c").write_text("int main(void) { return 0; }\n")
    return repo


def build_harness(
    tmp_path: Path,
    task_repo: Path,
    provider: FakeProvider,
    approver: ScriptedApprover,
    toolhost: FakeToolHost | None = None,
    **cfg_overrides: Any,
) -> Harness:
    record_dir = tmp_path / "record"
    cfg = RunConfig(
        task="test task",
        repo=task_repo,
        model="test-model",
        record_dir=record_dir,
        **cfg_overrides,
    )
    recorder = RunRecorder(record_dir, cfg.run_id, REPO_ROOT)

    async def factory():
        return toolhost

    return Harness(
        cfg=cfg,
        recorder=recorder,
        provider=provider,
        workspace=Workspace(task_repo),
        approver=approver,
        toolhost_factory=factory,
    )
