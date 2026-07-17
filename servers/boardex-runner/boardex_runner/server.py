"""The Boardex real runner service: BIBLE §5.3 command API + WS event streams.

Routes, shapes and error semantics mirror the mock runner exactly (the mock is
the reference implementation); `/health` reports ``runnerKind: "real"``.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

from .artifacts import ArtifactStore
from .clock import Clock, VirtualClock
from .contract import (
    CONTRACT_VERSION,
    GLOBAL_EVENT_TYPES,
    TERMINAL_STATUSES,
    validate_event,
)
from .engine import Conflict, RunEngine, new_run_id
from .fake_bench import FakeBench, fake_board_profile
from .recorder import FixtureRecorder

DEFAULT_PORT = 4380
_LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")
# Staleness bound for the off-loop bench snapshot (audit HIGH-2). The UI treats
# bench status as advisory, so a few seconds of staleness is acceptable and it
# stops repeated GET /bench + dashboard connects from hammering the probe.
_BENCH_STATUS_TTL_S = 5.0


class RunnerApp:
    """Holds runner-wide state: profiles, runs, artifacts, WS subscribers."""

    def __init__(
        self,
        *,
        bench_factory: Any,
        clock_factory: Any,
        artifacts: ArtifactStore | None = None,
        recorder: FixtureRecorder | None = None,
        board_profiles: list[dict[str, Any]] | None = None,
        bench_status: dict[str, Any] | None = None,
        engine_cls: type[RunEngine] = RunEngine,
        models: list[str] | None = None,
    ) -> None:
        self.bench_factory = bench_factory
        self.clock_factory = clock_factory
        self.artifacts = artifacts or ArtifactStore()
        self.recorder = recorder
        self.engine_cls = engine_cls
        # v2.1 capabilities.models; None => no model choice advertised (§5.3).
        self.models = models
        self.runs: dict[str, RunEngine] = {}
        self.board_profiles: dict[str, dict[str, Any]] = {
            str(profile["id"]): profile
            for profile in (board_profiles or [fake_board_profile()])
        }
        self._bench_status = bench_status
        self._bench_status_cache: dict[str, Any] | None = None
        self._bench_status_at = 0.0
        # WS fan-out: one outbound queue per client, drained by a single writer
        # task, so per-client frame order always matches emit order.
        self.run_clients: dict[str, set[asyncio.Queue[str | None]]] = {}
        self.global_clients: set[asyncio.Queue[str | None]] = set()
        self._global_seq = 0
        self._recorded_run: str | None = None

    # -- event fan-out -------------------------------------------------------------

    def dispatch(self, engine: RunEngine, event: dict[str, Any]) -> None:
        if self.recorder is not None and engine.id == self._recorded_run:
            self.recorder.on_event(event)
            if event["type"] in ("run.completed", "run.failed", "run.stopped"):
                # The recorded stream is terminal: export its artifact bodies so
                # the fixture directory is self-contained (§10.3).
                self.recorder.export_artifacts(self.artifacts, engine.id)
        self._broadcast(self.run_clients.get(engine.id), event)
        if event["type"] in GLOBAL_EVENT_TYPES:
            self._broadcast(self.global_clients, event)

    def _broadcast(
        self, clients: set["asyncio.Queue[str | None]"] | None, event: dict[str, Any]
    ) -> None:
        if not clients:
            return
        message = json.dumps(event)
        for queue in list(clients):
            queue.put_nowait(message)

    # -- run lifecycle ---------------------------------------------------------------

    def _active_run(self) -> RunEngine | None:
        """The one non-terminal run, if any (used to arbitrate exclusive benches)."""
        return next(
            (e for e in self.runs.values() if e.status not in TERMINAL_STATUSES),
            None,
        )

    def create_run(
        self, task_prompt: str, board_profile_id: str, model: str | None = None
    ) -> str | Conflict:
        bench = self.bench_factory()
        # Audit HIGH-1: an exclusive bench (real/agent) owns one physical probe
        # + analyzer; a second concurrent run would clobber shared evidence and
        # the debug session. Serialize by refusing to start while a run is live.
        if getattr(bench, "exclusive", False):
            active = self._active_run()
            if active is not None:
                return Conflict("bench busy", active.status)
        run_id = new_run_id()
        profile = self.board_profiles.get(board_profile_id)
        if profile is None:
            # Tolerant like the mock: an unknown profile falls back to the
            # canned one rather than failing run creation.
            profile = next(iter(self.board_profiles.values()))
        engine = self.engine_cls(
            run_id=run_id,
            task_prompt=task_prompt,
            profile=profile,
            bench=bench,
            clock=self.clock_factory(),
            artifacts=self.artifacts,
            on_event=lambda event, _rid=run_id: self.dispatch(self.runs[_rid], event),
            model=model,
        )
        self.runs[run_id] = engine
        if self.recorder is not None and self._recorded_run is None:
            self._recorded_run = run_id
        engine.start()
        return run_id

    async def bench_status(self) -> dict[str, Any]:
        """§5.3 GET /bench + global-WS snapshot.

        A blocking bench's snapshot runs a live hardware scan (pyOCD USB
        enumeration + ``sigrok-cli --scan``, up to ~20 s). Running it on the
        loop thread freezes every run's event stream for that whole window
        (audit HIGH-2). Offload it to the executor and cache the result for a
        few seconds so bursts of dashboard connects don't stack scans.
        """
        if self._bench_status is not None:
            return self._bench_status
        bench = self.bench_factory()
        if not getattr(bench, "blocking", False):
            return bench.bench_status()
        loop = asyncio.get_running_loop()
        now = loop.time()
        if (
            self._bench_status_cache is not None
            and now - self._bench_status_at < _BENCH_STATUS_TTL_S
        ):
            return self._bench_status_cache
        snapshot = await loop.run_in_executor(None, bench.bench_status)
        self._bench_status_cache = snapshot
        self._bench_status_at = now
        return snapshot


# -- HTTP handlers --------------------------------------------------------------------


def _cors(request: web.Request) -> dict[str, str]:
    origin = request.headers.get("Origin", "")
    allowed = origin if _LOCAL_ORIGIN.match(origin) else "http://localhost:5173"
    return {
        "Access-Control-Allow-Origin": allowed,
        "Vary": "Origin",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }


def _json(request: web.Request, status: int, body: Any) -> web.Response:
    return web.json_response(body, status=status, headers=_cors(request))


def _error(request: web.Request, status: int, error: str) -> web.Response:
    return _json(request, status, {"error": error})


def _command(request: web.Request, conflict: Conflict | None) -> web.Response:
    if conflict is None:
        return web.Response(status=204, headers=_cors(request))
    return _json(
        request, 409, {"error": conflict.error, "currentStatus": conflict.current_status}
    )


async def _read_body(request: web.Request) -> Any:
    raw = await request.text()
    if not raw.strip():
        return {}
    return json.loads(raw)


def build_app(state: RunnerApp) -> web.Application:
    app = web.Application()

    async def options_handler(request: web.Request) -> web.Response:
        return web.Response(status=204, headers=_cors(request))

    async def health(request: web.Request) -> web.Response:
        payload: dict[str, Any] = {
            "ok": True,
            "contractVersion": CONTRACT_VERSION,
            "runnerKind": "real",
        }
        if state.models:
            payload["capabilities"] = {"models": state.models}
        return _json(request, 200, payload)

    async def bench(request: web.Request) -> web.Response:
        return _json(request, 200, await state.bench_status())

    async def list_profiles(request: web.Request) -> web.Response:
        return _json(request, 200, list(state.board_profiles.values()))

    async def save_profile(request: web.Request) -> web.Response:
        try:
            body = await _read_body(request)
        except json.JSONDecodeError:
            return _error(request, 400, "invalid JSON body")
        if not isinstance(body, dict) or not body.get("id"):
            return _error(request, 400, "invalid board profile")
        state.board_profiles[str(body["id"])] = body
        return _json(request, 200, body)

    async def list_runs(request: web.Request) -> web.Response:
        return _json(request, 200, [engine.summary() for engine in state.runs.values()])

    async def create_run(request: web.Request) -> web.Response:
        try:
            body = await _read_body(request)
        except json.JSONDecodeError:
            return _error(request, 400, "invalid JSON body")
        if (
            not isinstance(body, dict)
            or not isinstance(body.get("taskPrompt"), str)
            or not isinstance(body.get("boardProfileId"), str)
        ):
            return _error(request, 400, "invalid create-run request")
        model = body.get("model")
        if model is not None and not isinstance(model, str):
            return _error(request, 400, "invalid create-run request")
        if state.models is not None:
            # A model outside the advertised list conflicts with the runner's
            # capabilities (409, like any command invalid against server state).
            if model is None:
                model = state.models[0]
            elif model not in state.models:
                return _json(
                    request,
                    409,
                    {"error": f'model "{model}" is not in this runner\'s advertised model list'},
                )
        result = state.create_run(body["taskPrompt"], body["boardProfileId"], model)
        if isinstance(result, Conflict):
            return _json(
                request,
                409,
                {"error": result.error, "currentStatus": result.current_status},
            )
        return _json(request, 200, {"runId": result})

    def _engine(request: web.Request) -> RunEngine | None:
        return state.runs.get(request.match_info["run_id"])

    async def run_events(request: web.Request) -> web.Response:
        engine = _engine(request)
        if engine is None:
            return _error(request, 404, "run not found")
        try:
            after_seq = int(request.query.get("afterSeq", "0"))
        except ValueError:
            after_seq = 0
        return _json(request, 200, engine.events_after(after_seq))

    async def stop_run(request: web.Request) -> web.Response:
        engine = _engine(request)
        if engine is None:
            return _error(request, 404, "run not found")
        return _command(request, engine.stop())

    async def approve_plan(request: web.Request) -> web.Response:
        engine = _engine(request)
        if engine is None:
            return _error(request, 404, "run not found")
        return _command(request, engine.approve_plan())

    async def resolve_approval(request: web.Request) -> web.Response:
        engine = _engine(request)
        if engine is None:
            return _error(request, 404, "run not found")
        try:
            body = await _read_body(request)
        except json.JSONDecodeError:
            return _error(request, 400, "invalid JSON body")
        status = body.get("status") if isinstance(body, dict) else None
        if status not in ("approved", "rejected"):
            return _error(request, 400, "invalid approval resolution")
        return _command(
            request, engine.resolve_approval(request.match_info["approval_id"], status)
        )

    async def artifact_meta(request: web.Request) -> web.Response:
        meta = state.artifacts.meta(request.match_info["artifact_id"])
        if meta is None:
            return _error(request, 404, "artifact not found")
        return _json(request, 200, meta)

    async def artifact_content(request: web.Request) -> web.Response:
        stored = state.artifacts.get(request.match_info["artifact_id"])
        if stored is None:
            return _error(
                request, 404, f'artifact "{request.match_info["artifact_id"]}" not found'
            )
        return web.Response(
            body=stored.content,
            headers={"Content-Type": str(stored.meta["mimeType"]), **_cors(request)},
        )

    async def _serve_ws(
        ws: web.WebSocketResponse, registry: set["asyncio.Queue[str | None]"]
    ) -> None:
        """Pump queued events to the socket until the client disconnects."""
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        registry.add(queue)

        async def reader() -> None:
            # Server pushes only (§5.3); the reader exists to observe close.
            async for msg in ws:
                if msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                    break
            queue.put_nowait(None)

        reader_task = asyncio.get_running_loop().create_task(reader())
        try:
            while True:
                message = await queue.get()
                if message is None:
                    break
                await ws.send_str(message)
        except (ConnectionError, RuntimeError):
            pass
        finally:
            registry.discard(queue)
            reader_task.cancel()

    async def ws_handler(request: web.Request) -> web.StreamResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        if request.query.get("global") == "1":
            state._global_seq += 1
            snapshot = {
                "seq": state._global_seq,
                "runId": "_global",
                "ts": Clock().now_iso(),
                "type": "runner.status",
                "payload": {"bench": await state.bench_status()},
            }
            validate_event(snapshot)
            await ws.send_str(json.dumps(snapshot))
            await _serve_ws(ws, state.global_clients)
            return ws
        run_id = request.query.get("runId")
        if not run_id or run_id not in state.runs:
            await ws.close(code=1008, message=b"unknown runId")
            return ws
        await _serve_ws(ws, state.run_clients.setdefault(run_id, set()))
        return ws

    app.router.add_route("OPTIONS", "/{tail:.*}", options_handler)
    app.router.add_get("/health", health)
    app.router.add_get("/bench", bench)
    app.router.add_get("/board-profiles", list_profiles)
    app.router.add_post("/board-profiles", save_profile)
    app.router.add_get("/runs", list_runs)
    app.router.add_post("/runs", create_run)
    app.router.add_get("/runs/{run_id}/events", run_events)
    app.router.add_post("/runs/{run_id}/stop", stop_run)
    app.router.add_post("/runs/{run_id}/plan/approve", approve_plan)
    app.router.add_post("/runs/{run_id}/approvals/{approval_id}", resolve_approval)
    app.router.add_get("/artifacts/{artifact_id}/meta", artifact_meta)
    app.router.add_get("/artifacts/{artifact_id}", artifact_content)
    app.router.add_get("/ws", ws_handler)
    return app


# -- process entry point -----------------------------------------------------------------


def _board_profiles_from_env() -> list[dict[str, Any]] | None:
    """Load board profiles baked into launch via ``BOARDEX_BOARD_PROFILES``.

    The file is a single BoardProfile object or a JSON array of them. Baking the
    profile into the launch means it survives runner restarts — otherwise a
    profile only lives in runner memory (POST /board-profiles) and a restart
    silently drops back to the default, so a run created against its id resolves
    to a profile whose ``repoPath`` doesn't exist (agent bench fails on start).
    Returns ``None`` when unset, so the caller keeps its default profile.
    """
    path = os.environ.get("BOARDEX_BOARD_PROFILES")
    if not path:
        return None
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    profiles = raw if isinstance(raw, list) else [raw]
    if not profiles or not all(
        isinstance(profile, dict) and profile.get("id") for profile in profiles
    ):
        raise SystemExit(
            "BOARDEX_BOARD_PROFILES must be a board profile object (or array) "
            "each with an 'id'"
        )
    return profiles


def state_from_env() -> RunnerApp:
    """Build runner state from environment configuration.

    BENCH=fake (default until real hardware config is supplied) | real | agent
    SPEED    — fake-bench pacing divisor (virtual clock)
    FIXTURE=fail — fake bench replays the fail-variant arc
    RECORD=<dir> — tee the first run to <dir>/recorded_run.jsonl (+ artifacts/)
    BOARDEX_BENCH_CONFIG=<json file> — RealBench configuration (BENCH=real)
    BOARDEX_BOARD_PROFILES=<json file> — board profile(s) baked in at launch
        (survives restarts; BENCH=fake|agent)
    AGENT_MODELS=<csv> — LiteLLM model strings advertised via capabilities (BENCH=agent)
    AGENT_MAX_TURNS=<n> — agent turn budget per run (BENCH=agent, default 40)
    """
    bench_kind = os.environ.get("BENCH", "fake")
    speed = float(os.environ.get("SPEED", "1"))
    # PACING stretches the fake bench's narrative time (virtual timestamps)
    # without slowing the process: PACING=17 makes a recording span ~10 minutes
    # like a genuine bench run, at any SPEED.
    pacing = float(os.environ.get("PACING", "1"))
    fail_variant = os.environ.get("FIXTURE") == "fail"
    recorder = None
    record_dir = os.environ.get("RECORD")
    if record_dir:
        recorder = FixtureRecorder(Path(record_dir), "recorded_run")

    if bench_kind == "agent":
        from .agent_bench import (
            AgentBench,
            AgentRunEngine,
            agent_bench_status,
            agent_models_from_env,
        )

        max_turns = int(os.environ.get("AGENT_MAX_TURNS", "40"))
        return RunnerApp(
            # One AgentBench per run — never a shared instance (audit HIGH-1).
            bench_factory=lambda: AgentBench(max_turns=max_turns),
            clock_factory=Clock,
            recorder=recorder,
            engine_cls=AgentRunEngine,
            models=agent_models_from_env(),
            bench_status=agent_bench_status(),
            board_profiles=_board_profiles_from_env(),
        )

    if bench_kind == "real":
        from .real_bench import RealBench, RealBenchConfig

        config_path = os.environ.get("BOARDEX_BENCH_CONFIG")
        if not config_path:
            raise SystemExit("BENCH=real requires BOARDEX_BENCH_CONFIG=<json file>")
        raw = json.loads(Path(config_path).read_text(encoding="utf-8"))
        profile = raw.pop("profile")
        config = RealBenchConfig(profile=profile, **raw)
        bench = RealBench(config)  # one bench: it owns sessions/hardware
        return RunnerApp(
            bench_factory=lambda: bench,
            clock_factory=Clock,
            recorder=recorder,
            board_profiles=[profile],
        )

    return RunnerApp(
        bench_factory=lambda: FakeBench(fail_variant=fail_variant),
        clock_factory=lambda: VirtualClock(speed=speed, dilation=pacing),
        recorder=recorder,
        board_profiles=_board_profiles_from_env(),
    )


def main() -> None:
    port = int(os.environ.get("PORT", str(DEFAULT_PORT)))
    host = os.environ.get("HOST", "127.0.0.1")
    state = state_from_env()
    app = build_app(state)
    print(f"boardex-runner (real) listening on http://{host}:{port}")
    web.run_app(app, host=host, port=port, print=None)


if __name__ == "__main__":
    main()
