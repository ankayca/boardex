"""Shared helpers for the runner suite: drive an engine to a terminal state.

All tests are hardware-free (FakeBench + VirtualClock) and run the real engine
and wire layer — the same code paths the live bench uses.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from boardex_runner.artifacts import ArtifactStore
from boardex_runner.clock import VirtualClock
from boardex_runner.engine import RunEngine, new_run_id
from boardex_runner.fake_bench import FakeBench, fake_board_profile

TERMINAL = {"completed", "failed", "stopped"}
SPEED = 2000.0  # virtual-clock divisor; a full run finishes in well under a second


@pytest.fixture(autouse=True)
def isolated_state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """No test may read or write the developer's real ``~/.boardex``.

    Runner state (board profiles, provider keys) now rests on disk, so a suite
    without this fixture would seed itself from whoever's home directory it ran
    in — a developer with a saved key would pass tests that fail in CI — and
    could overwrite that person's actual state. Every test gets its own empty
    directory, and one that wants the not-yet-created case simply never writes.
    """
    state = tmp_path / "state"
    monkeypatch.setenv("BOARDEX_STATE_DIR", str(state))
    return state


def make_engine(
    *,
    fail_variant: bool = False,
    on_event: Any = None,
    artifacts: ArtifactStore | None = None,
) -> RunEngine:
    return RunEngine(
        run_id=new_run_id(),
        task_prompt="Bring up BME280 over I2C on the Nucleo-F303RE. Verify I2C "
        "timing and confirm valid temperature/humidity readings over serial.",
        profile=fake_board_profile(),
        bench=FakeBench(fail_variant=fail_variant),
        clock=VirtualClock(speed=SPEED),
        artifacts=artifacts or ArtifactStore(),
        on_event=on_event,
    )


def pending_approval_id(events: list[dict[str, Any]]) -> str | None:
    requested = [
        e["payload"]["approval"]["id"] for e in events if e["type"] == "approval.requested"
    ]
    resolved = {
        e["payload"]["approvalId"] for e in events if e["type"] == "approval.resolved"
    }
    for approval_id in requested:
        if approval_id not in resolved:
            return approval_id
    return None


async def drive_to_terminal(
    engine: RunEngine,
    *,
    approve_plan: bool = True,
    resolve: str = "approved",
    max_iters: int = 20_000,
) -> list[dict[str, Any]]:
    """Approve the plan and every pending approval until the run is terminal."""
    engine.start()
    for _ in range(max_iters):
        if engine.log.sealed:
            await asyncio.sleep(0)  # let the pipeline task unwind
            return engine.log.events
        events = engine.log.events
        if engine.status == "plan_ready" and approve_plan:
            engine.approve_plan()
        pending = pending_approval_id(events)
        if pending is not None:
            engine.resolve_approval(pending, resolve)
        await asyncio.sleep(0.002)
    raise AssertionError("run did not reach a terminal state in time")


def run(coro: Any) -> Any:
    return asyncio.run(coro)


# -- agent-bench helpers (BENCH=agent suite) -----------------------------------
#
# All agent tests are LLM-free and hardware-free: a scripted provider serves
# canned tool-call turns (CI never needs an API key) and a fake tool host
# stands in for the MCP layer, driving the real AgentRunEngine + wire layer.

import json
from pathlib import Path

from boardex_runner.agent_bench import AgentBench, AgentRunEngine
from boardex_runner.clock import Clock
from boardex_runner.provider import ModelTurn, ToolCall

FLASH_DESC = "Flash a firmware image (.elf/.hex/.bin) onto a target and reset it."
BUILD_DESC = "Build an external firmware project and return the built artifact path."

VALID_PLAN_ARGS: dict[str, Any] = {
    "steps": [
        {"title": "Understand", "detail": "Read the repo", "riskLevel": "low", "hardwareAction": False},
        {"title": "Do the thing", "detail": "Edit, build, flash", "riskLevel": "medium", "hardwareAction": True},
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


def make_turn(
    content: str | None = None,
    calls: list[tuple[str, dict[str, Any]]] | None = None,
    usage: dict[str, int] | None = None,
) -> ModelTurn:
    tool_calls = []
    raw_calls = []
    for i, (name, args) in enumerate(calls or []):
        raw = json.dumps(args)
        tool_calls.append(
            ToolCall(id=f"call_{name}_{i}", name=name, arguments=args, raw_arguments=raw)
        )
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
    return ModelTurn(
        content=content, tool_calls=tool_calls, raw_message=raw_message, usage=usage
    )


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


class HangingProvider:
    """A provider whose completion never returns — the mid-turn stop target."""

    def __init__(self) -> None:
        self.entered = asyncio.Event()

    async def complete(self, messages, tools):  # noqa: ANN001
        self.entered.set()
        await asyncio.Event().wait()  # parks forever; stop() must cancel through it


class FakeToolHost:
    def __init__(
        self, tools: dict[str, str], results: dict[str, dict[str, Any]] | None = None
    ) -> None:
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
        self.closed = False

    def has_tool(self, name: str) -> bool:
        return name in self.descriptions

    async def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        self.invocations.append((name, args))
        return self.results.get(name, {"verdict": "pass", "data": {}})

    async def close(self) -> None:
        self.closed = True


def agent_profile(repo: Path, **safety_overrides: Any) -> dict[str, Any]:
    profile = fake_board_profile()
    profile["repoPath"] = str(repo)
    profile["safety"] = {**profile["safety"], **safety_overrides}
    return profile


def make_agent_engine(
    task_repo: Path,
    provider: Any,
    toolhost: FakeToolHost | None = None,
    *,
    run_id: str = "run_agent1",
    model: str = "test-model",
    max_turns: int = 40,
    profile: dict[str, Any] | None = None,
    on_event: Any = None,
    artifacts: ArtifactStore | None = None,
) -> AgentRunEngine:
    async def toolhost_factory() -> FakeToolHost | None:
        return toolhost

    return AgentRunEngine(
        run_id=run_id,  # fixed so artifact ids (art_agent1_NNN_kind) are scriptable
        task_prompt="test task",
        profile=profile or agent_profile(task_repo),
        bench=AgentBench(
            max_turns=max_turns,
            provider_factory=lambda _model: provider,
            toolhost_factory=toolhost_factory,
        ),
        clock=Clock(),
        artifacts=artifacts or ArtifactStore(),
        on_event=on_event,
        model=model,
    )
