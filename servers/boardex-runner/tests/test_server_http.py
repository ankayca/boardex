"""HTTP + WS conformance against a real listening server (BIBLE §5.3).

Mirrors the mock runner's integration suite: full run over HTTP+WS, replay
after a WS drop, stop, reject, 404s, 409s, artifact MIME, global stream.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import aiohttp
from aiohttp import web

from boardex_runner.artifacts import ArtifactStore
from boardex_runner.clock import VirtualClock
from boardex_runner.contract import validate_event
from boardex_runner.fake_bench import FakeBench
from boardex_runner.server import RunnerApp, build_app

from conftest import run

TERMINAL = {"completed", "failed", "stopped"}
SPEED = 2000.0


class Harness:
    """One listening runner + one HTTP client session."""

    def __init__(self, *, fail_variant: bool = False) -> None:
        self.state = RunnerApp(
            bench_factory=lambda: FakeBench(fail_variant=fail_variant),
            clock_factory=lambda: VirtualClock(speed=SPEED),
            artifacts=ArtifactStore(),
        )
        self.runner: web.AppRunner | None = None
        self.session: aiohttp.ClientSession | None = None
        self.base = ""

    async def __aenter__(self) -> "Harness":
        self.runner = web.AppRunner(build_app(self.state))
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = self.runner.addresses[0][1]
        self.base = f"http://127.0.0.1:{port}"
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

    async def events(self, run_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
        events = await self.get_json(f"/runs/{run_id}/events?afterSeq={after_seq}")
        for event in events:
            validate_event(event)
        return events

    async def create_run(self) -> str:
        res = await self.post(
            "/runs",
            {"taskPrompt": "bring up BME280", "boardProfileId": "bp_nucleo_f303re"},
        )
        assert res.status == 200
        return (await res.json())["runId"]

    async def drive_to_terminal(self, run_id: str) -> list[dict[str, Any]]:
        resolved: set[str] = set()
        for _ in range(20_000):
            events = await self.events(run_id)
            status = _status_of(events)
            if status in TERMINAL:
                return events
            if status == "plan_ready" and "__plan__" not in resolved:
                if (await self.post(f"/runs/{run_id}/plan/approve")).status == 204:
                    resolved.add("__plan__")
            pending = _pending_approval(events)
            if pending and pending not in resolved:
                res = await self.post(
                    f"/runs/{run_id}/approvals/{pending}", {"status": "approved"}
                )
                if res.status == 204:
                    resolved.add(pending)
            await asyncio.sleep(0.003)
        raise AssertionError("run did not reach a terminal state in time")


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


def _assert_contiguous(events: list[dict[str, Any]], first: int, last: int) -> None:
    assert events[0]["seq"] == first
    assert events[-1]["seq"] == last
    for i, event in enumerate(events):
        assert event["seq"] == first + i


def test_health_reports_real_and_contract_version() -> None:
    async def scenario() -> None:
        async with Harness() as h:
            health = await h.get_json("/health")
            assert health == {
                "ok": True,
                "contractVersion": "boardex-contract/0.1",
                "runnerKind": "real",
            }

    run(scenario())


def test_bench_and_board_profiles_roundtrip() -> None:
    async def scenario() -> None:
        async with Harness() as h:
            bench = await h.get_json("/bench")
            assert bench["runnerOnline"] is True
            assert bench["contractVersion"] == "boardex-contract/0.1"
            assert {d["kind"] for d in bench["devices"]} >= {"debug_probe", "serial"}

            profiles = await h.get_json("/board-profiles")
            assert profiles[0]["id"] == "bp_nucleo_f303re"
            updated = dict(profiles[0], name="Nucleo-F303RE (edited)")
            res = await h.post("/board-profiles", updated)
            assert res.status == 200
            profiles = await h.get_json("/board-profiles")
            assert profiles[0]["name"] == "Nucleo-F303RE (edited)"

    run(scenario())


def test_full_run_over_http_and_ws() -> None:
    async def scenario() -> None:
        async with Harness() as h:
            run_id = await h.create_run()
            assert h.session
            ws = await h.session.ws_connect(f"{h.base}/ws?runId={run_id}")
            ws_events: list[dict[str, Any]] = []

            async def collect() -> None:
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        break
                    event = json.loads(msg.data)
                    validate_event(event)
                    ws_events.append(event)
                    if event["type"] in (
                        "run.completed",
                        "run.failed",
                        "run.stopped",
                    ):
                        break

            collector = asyncio.ensure_future(collect())
            events = await h.drive_to_terminal(run_id)
            await asyncio.wait_for(collector, timeout=10)
            await ws.close()

            _assert_contiguous(events, 1, len(events))
            assert events[0]["type"] == "run.created"
            assert events[-1]["type"] == "run.completed"
            # WS delivered the live tail including the terminal event.
            assert ws_events[-1]["type"] == "run.completed"
            # Live tail is itself gapless.
            for a, b in zip(ws_events, ws_events[1:]):
                assert b["seq"] == a["seq"] + 1

    run(scenario())


def test_ws_drop_and_http_replay_reconstruct_gapless_stream() -> None:
    async def scenario() -> None:
        async with Harness() as h:
            run_id = await h.create_run()
            assert h.session
            seen: dict[int, dict[str, Any]] = {}

            ws_a = await h.session.ws_connect(f"{h.base}/ws?runId={run_id}")
            for event in await h.events(run_id):
                seen[event["seq"]] = event

            driving = asyncio.ensure_future(h.drive_to_terminal(run_id))
            # Collect live until mid-run, then drop the socket.
            while True:
                msg = await asyncio.wait_for(ws_a.receive(), timeout=10)
                if msg.type != aiohttp.WSMsgType.TEXT:
                    break
                event = json.loads(msg.data)
                seen[event["seq"]] = event
                if event["seq"] >= 30:
                    break
            await ws_a.close()
            last_seq = max(seen)

            final = await driving
            total = len(final)
            replay = await h.events(run_id, after_seq=last_seq)
            assert all(e["seq"] > last_seq for e in replay), "no duplicates"
            _assert_contiguous(replay, last_seq + 1, total)
            for event in replay:
                seen[event["seq"]] = event
            merged = [seen[k] for k in sorted(seen)]
            _assert_contiguous(merged, 1, total)
            assert merged[-1]["type"] == "run.completed"

    run(scenario())


def test_stop_and_second_stop_conflict() -> None:
    async def scenario() -> None:
        async with Harness() as h:
            run_id = await h.create_run()
            for _ in range(10_000):
                if _status_of(await h.events(run_id)) == "plan_ready":
                    break
                await asyncio.sleep(0.003)
            assert (await h.post(f"/runs/{run_id}/plan/approve")).status == 204
            for _ in range(10_000):
                if _status_of(await h.events(run_id)) == "running":
                    break
                await asyncio.sleep(0.003)

            assert (await h.post(f"/runs/{run_id}/stop")).status == 204
            events = await h.events(run_id)
            assert events[-1]["type"] == "run.stopped"
            assert events[-1]["payload"]["byUser"] is True

            await asyncio.sleep(0.05)
            assert len(await h.events(run_id)) == len(events)

            second = await h.post(f"/runs/{run_id}/stop")
            assert second.status == 409
            body = await second.json()
            assert body["currentStatus"] == "stopped"
            assert "error" in body

    run(scenario())


def test_reject_routes_to_stopped_over_http() -> None:
    async def scenario() -> None:
        async with Harness() as h:
            run_id = await h.create_run()
            for _ in range(10_000):
                if _status_of(await h.events(run_id)) == "plan_ready":
                    break
                await asyncio.sleep(0.003)
            assert (await h.post(f"/runs/{run_id}/plan/approve")).status == 204
            pending = None
            for _ in range(10_000):
                pending = _pending_approval(await h.events(run_id))
                if pending:
                    break
                await asyncio.sleep(0.003)
            res = await h.post(
                f"/runs/{run_id}/approvals/{pending}", {"status": "rejected"}
            )
            assert res.status == 204
            for _ in range(10_000):
                events = await h.events(run_id)
                if _status_of(events) == "stopped":
                    break
                await asyncio.sleep(0.003)
            _assert_contiguous(events, 1, len(events))
            assert events[-1]["type"] == "run.stopped"
            resolution = next(e for e in events if e["type"] == "approval.resolved")
            assert resolution["payload"]["status"] == "rejected"

    run(scenario())


def test_unknown_run_id_is_404_everywhere() -> None:
    async def scenario() -> None:
        async with Harness() as h:
            assert h.session
            res = await h.session.get(f"{h.base}/runs/run_nope/events?afterSeq=0")
            assert res.status == 404
            assert (await h.post("/runs/run_nope/stop")).status == 404
            assert (await h.post("/runs/run_nope/plan/approve")).status == 404
            assert (
                await h.post("/runs/run_nope/approvals/apr_x", {"status": "approved"})
            ).status == 404
            # Unknown WS runId is refused with policy code 1008.
            ws = await h.session.ws_connect(f"{h.base}/ws?runId=run_nope")
            msg = await ws.receive()
            assert msg.type == aiohttp.WSMsgType.CLOSE
            assert ws.close_code == 1008

    run(scenario())


def test_artifacts_served_with_declared_mime_and_404() -> None:
    async def scenario() -> None:
        async with Harness() as h:
            run_id = await h.create_run()
            events = await h.drive_to_terminal(run_id)
            artifacts = [
                e["payload"]["artifact"] for e in events if e["type"] == "artifact.created"
            ]
            assert artifacts
            assert h.session
            for meta in artifacts:
                res = await h.session.get(f"{h.base}/artifacts/{meta['id']}")
                assert res.status == 200
                assert res.headers["Content-Type"] == meta["mimeType"]
                body = await res.read()
                assert len(body) == meta["sizeBytes"]
                meta_res = await h.session.get(f"{h.base}/artifacts/{meta['id']}/meta")
                assert meta_res.status == 200
                assert await meta_res.json() == meta
            report = next(m for m in artifacts if m["kind"] == "report_md")
            assert report["mimeType"] == "text/markdown"
            missing = await h.session.get(f"{h.base}/artifacts/does_not_exist")
            assert missing.status == 404

    run(scenario())


def test_global_stream_snapshot_and_dedicated_terminals() -> None:
    async def scenario() -> None:
        async with Harness() as h:
            assert h.session
            ws = await h.session.ws_connect(f"{h.base}/ws?global=1")
            first = json.loads((await ws.receive()).data)
            validate_event(first)
            assert first["type"] == "runner.status"
            assert first["runId"] == "_global"

            run_id = await h.create_run()
            driving = asyncio.ensure_future(h.drive_to_terminal(run_id))
            saw: list[str] = []
            while True:
                msg = await asyncio.wait_for(ws.receive(), timeout=15)
                if msg.type != aiohttp.WSMsgType.TEXT:
                    break
                event = json.loads(msg.data)
                assert event["type"] in (
                    "runner.status",
                    "run.created",
                    "run.status_changed",
                    "run.completed",
                    "run.failed",
                    "run.stopped",
                ), "only lifecycle events reach the dashboard"
                saw.append(event["type"])
                if event["type"] == "run.completed" and event["runId"] == run_id:
                    break
            await driving

            # Stopped terminal from a second run also reaches the dashboard.
            second = await h.create_run()
            for _ in range(10_000):
                if _status_of(await h.events(second)) == "plan_ready":
                    break
                await asyncio.sleep(0.003)
            assert (await h.post(f"/runs/{second}/stop")).status == 204
            while True:
                msg = await asyncio.wait_for(ws.receive(), timeout=10)
                event = json.loads(msg.data)
                if event["type"] == "run.stopped" and event["runId"] == second:
                    break
            await ws.close()
            assert "run.created" in saw

    run(scenario())


def test_run_summary_valid_in_pre_run_created_window() -> None:
    async def scenario() -> None:
        # Slow clock: POST /runs then GET /runs lands before run.created.
        state = RunnerApp(
            bench_factory=lambda: FakeBench(),
            clock_factory=lambda: VirtualClock(speed=1.0),
        )
        runner = web.AppRunner(build_app(state))
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        base = f"http://127.0.0.1:{runner.addresses[0][1]}"
        async with aiohttp.ClientSession() as session:
            res = await session.post(
                base + "/runs",
                json={"taskPrompt": "x", "boardProfileId": "bp_nucleo_f303re"},
            )
            run_id = (await res.json())["runId"]
            listing = await (await session.get(base + "/runs")).json()
            summary = next(s for s in listing if s["id"] == run_id)
            assert summary["status"] == "draft"
            assert summary["title"]
            assert summary["boardProfileId"] == "bp_nucleo_f303re"
            assert summary["updatedAt"]
            # Stop that beats run.created still yields a reducible stream.
            assert (await session.post(base + f"/runs/{run_id}/stop")).status == 204
            events = await (
                await session.get(base + f"/runs/{run_id}/events?afterSeq=0")
            ).json()
            assert events[0]["type"] == "run.created"
            assert events[-1]["type"] == "run.stopped"
        for engine in state.runs.values():
            engine.dispose()
        await runner.cleanup()

    run(scenario())


def test_fail_variant_over_http() -> None:
    async def scenario() -> None:
        async with Harness(fail_variant=True) as h:
            run_id = await h.create_run()
            events = await h.drive_to_terminal(run_id)
            assert events[-1]["type"] == "run.failed"
            checks = [
                e["payload"]["check"] for e in events if e["type"] == "check.evaluated"
            ]
            final = {c["requirementId"]: c["verdict"] for c in checks[-3:]}
            assert final["i2c_clock"] == "pass"
            assert final["device_ack"] == "fail"
            assert final["serial_output"] == "fail"

    run(scenario())
