"""BENCH=agent over the real HTTP + WS wire layer: plan approval and the flash
gate resolve over HTTP, capabilities.models is advertised on /health, and
CreateRun.model is validated against it (unknown model -> 409)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import aiohttp
from aiohttp import web

from boardex_runner.agent_bench import AgentBench, AgentRunEngine, agent_bench_status
from boardex_runner.clock import Clock
from boardex_runner.contract import validate_event
from boardex_runner.server import RunnerApp, build_app

from conftest import (
    BUILD_DESC,
    FLASH_DESC,
    VALID_PLAN_ARGS,
    FakeProvider,
    FakeToolHost,
    agent_profile,
    make_turn,
    run,
)

TERMINAL = {"completed", "failed", "stopped"}
MODELS = ["model-a", "model-b"]


def _script() -> list[Any]:
    # Run ids (hence artifact ids) are random over HTTP, so this script skips
    # record_check; the evidence law is covered at engine level with a fixed
    # run id (test_agent_bench). The wire marriage is what this suite proves.
    plan = {**VALID_PLAN_ARGS, "checks": []}
    return [
        make_turn(content="Planning.", calls=[("declare_plan", plan)]),
        make_turn(calls=[("build_firmware", {"project_dir": "/proj"})]),
        make_turn(calls=[("flash_firmware", {"device_id": "pyocd:0", "firmware_path": "/x.elf"})]),
        make_turn(calls=[("write_report", {"markdown": "# Report\nBuild ok."})]),
    ]


class AgentHarness:
    """One listening BENCH=agent runner (scripted provider, fake tool host)."""

    def __init__(self, repo: Path) -> None:
        self.hosts: list[FakeToolHost] = []

        def bench() -> AgentBench:
            host = FakeToolHost(
                {"build_firmware": BUILD_DESC, "flash_firmware": FLASH_DESC},
                results={
                    "build_firmware": {"verdict": "pass", "data": {"stdout": "make: ok"}}
                },
            )
            self.hosts.append(host)

            async def toolhost_factory() -> FakeToolHost:
                return host

            return AgentBench(
                provider_factory=lambda _model: FakeProvider(_script()),
                toolhost_factory=toolhost_factory,
            )

        self.state = RunnerApp(
            bench_factory=bench,
            clock_factory=Clock,
            board_profiles=[agent_profile(repo)],
            bench_status=agent_bench_status(),
            engine_cls=AgentRunEngine,
            models=list(MODELS),
        )
        self.runner: web.AppRunner | None = None
        self.session: aiohttp.ClientSession | None = None
        self.base = ""

    async def __aenter__(self) -> "AgentHarness":
        self.runner = web.AppRunner(build_app(self.state))
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.base = f"http://127.0.0.1:{self.runner.addresses[0][1]}"
        self.session = aiohttp.ClientSession()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        assert self.session and self.runner
        await self.session.close()
        for engine in self.state.runs.values():
            engine.dispose()
        await self.runner.cleanup()

    async def get_json(self, path: str) -> Any:
        assert self.session
        async with self.session.get(self.base + path) as res:
            assert res.status == 200, f"GET {path} -> {res.status}"
            return await res.json()

    async def post(self, path: str, body: Any = None) -> aiohttp.ClientResponse:
        assert self.session
        return await self.session.post(self.base + path, json=body or {})

    async def events(self, run_id: str) -> list[dict[str, Any]]:
        events = await self.get_json(f"/runs/{run_id}/events?afterSeq=0")
        for event in events:
            validate_event(event)
        return events


def _status_of(events: list[dict[str, Any]]) -> str:
    status = "draft"
    for event in events:
        if event["type"] == "run.created":
            status = event["payload"]["run"]["status"]
        elif event["type"] == "run.status_changed":
            status = event["payload"]["status"]
        elif event["type"] in ("run.completed", "run.failed", "run.stopped"):
            status = event["type"].split(".")[1]
    return status


def _pending_approval(events: list[dict[str, Any]]) -> str | None:
    requested = [
        e["payload"]["approval"]["id"] for e in events if e["type"] == "approval.requested"
    ]
    resolved = {
        e["payload"]["approvalId"] for e in events if e["type"] == "approval.resolved"
    }
    return next((a for a in requested if a not in resolved), None)


def test_full_agent_run_over_http(tmp_path: Path) -> None:
    async def scenario() -> None:
        repo = tmp_path / "task-repo"
        repo.mkdir()
        (repo / "main.c").write_text("int main(void) { return 0; }\n")
        async with AgentHarness(repo) as h:
            res = await h.post(
                "/runs", {"taskPrompt": "port test", "boardProfileId": "bp_nucleo_f303re"}
            )
            assert res.status == 200
            run_id = (await res.json())["runId"]

            resolved: set[str] = set()
            events: list[dict[str, Any]] = []
            for _ in range(20_000):
                events = await h.events(run_id)
                status = _status_of(events)
                if status in TERMINAL:
                    break
                if status == "plan_ready" and "__plan__" not in resolved:
                    if (await h.post(f"/runs/{run_id}/plan/approve")).status == 204:
                        resolved.add("__plan__")
                pending = _pending_approval(events)
                if pending and pending not in resolved:
                    if (
                        await h.post(f"/runs/{run_id}/approvals/{pending}", {"status": "approved"})
                    ).status == 204:
                        resolved.add(pending)
                await asyncio.sleep(0.003)

            assert events[-1]["type"] == "run.completed"
            # No model requested -> the first advertised model is used and echoed.
            assert events[0]["payload"]["run"]["model"] == "model-a"
            # The flash gate resolved over HTTP before the flash ran.
            types = [e["type"] for e in events]
            assert types.index("approval.requested") < types.index("approval.resolved")
            assert h.hosts and [name for name, _ in h.hosts[0].invocations] == [
                "build_firmware",
                "flash_firmware",
            ]
            # The report artifact is fetchable by reference.
            report_id = events[-1]["payload"]["reportArtifactId"]
            assert h.session
            art = await h.session.get(f"{h.base}/artifacts/{report_id}")
            assert art.status == 200
            assert art.headers["Content-Type"] == "text/markdown"

    run(scenario())


def test_health_advertises_models_and_create_run_validates_them(tmp_path: Path) -> None:
    async def scenario() -> None:
        repo = tmp_path / "task-repo"
        repo.mkdir()
        async with AgentHarness(repo) as h:
            health = await h.get_json("/health")
            assert health["runnerKind"] == "real"
            assert health["capabilities"] == {"models": MODELS}

            # A model outside the advertised list is rejected, no run created.
            res = await h.post(
                "/runs",
                {
                    "taskPrompt": "x",
                    "boardProfileId": "bp_nucleo_f303re",
                    "model": "model-nope",
                },
            )
            assert res.status == 409
            body = await res.json()
            assert "model" in body["error"]
            assert h.state.runs == {}

            # A model inside the list is accepted and echoed onto Run.model.
            res = await h.post(
                "/runs",
                {
                    "taskPrompt": "x",
                    "boardProfileId": "bp_nucleo_f303re",
                    "model": "model-b",
                },
            )
            assert res.status == 200
            run_id = (await res.json())["runId"]
            for _ in range(10_000):
                events = await h.events(run_id)
                if events:
                    break
                await asyncio.sleep(0.003)
            assert events[0]["payload"]["run"]["model"] == "model-b"
            assert (await h.post(f"/runs/{run_id}/stop")).status == 204

    run(scenario())


def test_stop_over_http_seals_an_agent_run(tmp_path: Path) -> None:
    async def scenario() -> None:
        repo = tmp_path / "task-repo"
        repo.mkdir()
        async with AgentHarness(repo) as h:
            res = await h.post(
                "/runs", {"taskPrompt": "x", "boardProfileId": "bp_nucleo_f303re"}
            )
            run_id = (await res.json())["runId"]
            for _ in range(10_000):
                if _status_of(await h.events(run_id)) == "plan_ready":
                    break
                await asyncio.sleep(0.003)

            assert (await h.post(f"/runs/{run_id}/stop")).status == 204
            events = await h.events(run_id)
            assert events[-1]["type"] == "run.stopped"
            await asyncio.sleep(0.05)
            assert len(await h.events(run_id)) == len(events)
            second = await h.post(f"/runs/{run_id}/stop")
            assert second.status == 409
            assert (await second.json())["currentStatus"] == "stopped"

    run(scenario())
