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

from . import credentials, persistence
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
from .static_ui import add_ui_routes, ui_root_from_env

DEFAULT_PORT = 4380
_LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")
# Same two names, unschemed: the Host header the credential routes require.
_LOCAL_HOST = re.compile(r"^(localhost|127\.0\.0\.1)(:\d+)?$")
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
        profile_store: persistence.ProfileStore | None = None,
    ) -> None:
        self.bench_factory = bench_factory
        self.clock_factory = clock_factory
        self.artifacts = artifacts or ArtifactStore()
        self.recorder = recorder
        self.engine_cls = engine_cls
        # v2.1 capabilities.models; None => no model choice advertised (§5.3).
        self.models = models
        self.runs: dict[str, RunEngine] = {}
        # Board profiles come from up to two places, and only ever one of them
        # writes. ``profile_store`` (None => the pre-persistence behavior, which
        # is what every direct-construction test wants: no process may read the
        # developer's ~/.boardex by accident) supplies what earlier sessions
        # saved; ``board_profiles`` is launch configuration — BENCH=real's
        # bench.json profile, or BOARDEX_BOARD_PROFILES — and WINS on a shared
        # id, because a bench profile has to describe the hardware actually
        # wired to this host, not whatever a browser last saved under that id.
        self.profile_store = profile_store
        # Kept apart from the merged view because it is what gets WRITTEN: the
        # store holds user-saved profiles only. A launch profile or the
        # synthetic fallback written in here would fossilize a copy of a source
        # that re-supplies itself every boot — and would then outlive it,
        # shadowing a bench.json the operator later edits.
        self._saved_profiles: dict[str, dict[str, Any]] = (
            profile_store.load() if profile_store is not None else {}
        )
        supplied = {str(profile["id"]): profile for profile in (board_profiles or [])}
        # Launch profiles first, and they win on a shared id. First also in
        # ORDER, so the list the dashboard renders leads with the bench this
        # runner was actually launched against.
        merged: dict[str, dict[str, Any]] = dict(supplied)
        for profile_id, profile in self._saved_profiles.items():
            merged.setdefault(profile_id, profile)
        if not merged:
            # Unchanged fallback: a runner always has at least one profile.
            fallback = fake_board_profile()
            merged = {str(fallback["id"]): fallback}
        self.board_profiles: dict[str, dict[str, Any]] = merged
        # The profile an unknown id resolves to. Stated explicitly rather than
        # left to whatever dict happens to iterate first: on a real bench the
        # fallback drives physical hardware, so it has to be the profile this
        # runner was LAUNCHED with — flashing a saved profile's firmware onto
        # the wired board is the one mistake here that costs a device.
        self._fallback_profile_id = next(iter(supplied), next(iter(merged)))
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

    # -- board profiles --------------------------------------------------------------

    def save_profile(self, profile: dict[str, Any]) -> None:
        """Store a profile and write the whole set through to disk.

        Write-through, not a flush on shutdown: the runner is killed with Ctrl-C
        and hardware sessions do die mid-run, so state that is only durable
        after a clean exit is not durable. The in-memory update happens whether
        or not the disk write does (persistence.write_json never raises), so an
        unwritable home costs restart survival and nothing else.
        """
        profile_id = str(profile["id"])
        self.board_profiles[profile_id] = profile
        self._saved_profiles[profile_id] = profile
        if self.profile_store is not None:
            # Only the user-saved set: the fallback profile and the launch
            # config are re-supplied on every boot and must not be copied here.
            self.profile_store.save(self._saved_profiles)

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
            # Tolerant like the mock: an unknown profile falls back rather than
            # failing run creation — to the LAUNCH profile (see __init__), which
            # on a real bench is the one describing the wired hardware.
            profile = self.board_profiles[self._fallback_profile_id]
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
        # PUT/DELETE are advertised for the credential routes' preflight; every
        # other resource still implements only GET/POST and answers 405.
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }


def _is_local_client(request: web.Request) -> bool:
    """Host/Origin guard for the credential routes (and ONLY those).

    "It is localhost" is not authentication: a local port is reachable by every
    process on the machine, and — the case this exists for — by a page in the
    operator's own browser via DNS rebinding. An attacker page that resolves its
    own hostname to 127.0.0.1 can reach this port with the browser's blessing,
    and without this check it could set a provider key (billing the operator's
    account through a runner it now controls) or clear one (silently breaking
    every run). CORS does not help: it governs whether the page may READ the
    response, not whether the request is executed.

    So both are pinned, before any body is read: the Host header must name a
    loopback name (a rebound attacker hostname does not), and an Origin, when
    the browser sends one, must be a loopback origin.

    Deliberately asymmetric with the rest of the server: the other routes keep
    their existing CORS-only behavior, unchanged by this task.

    Be precise about what that leaves standing. This guard stops a rebound page
    from WRITING keys — it cannot set one, cannot replace one, cannot clear one.
    It does NOT stop that page from POSTing /runs, approving the plan and
    driving hardware, and a run started that way spends whatever key is
    currently active. So the residual exposure is not "nothing": it is
    unauthorized SPEND and unauthorized bench actuation, minus key theft and key
    tampering. Extending the guard to the run-starting and approval POSTs would
    close it and is the backend owner's call — those are contract routes with an
    external-runner conformance suite behind them, so tightening them is a
    contract-level decision, not a side effect of adding a credential store.
    """
    if not _LOCAL_HOST.match(request.headers.get("Host", "")):
        return False
    origin = request.headers.get("Origin")
    return origin is None or bool(_LOCAL_ORIGIN.match(origin))


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


def build_app(state: RunnerApp, ui_root: Path | None = None) -> web.Application:
    """The §5.3 API. With ``ui_root`` set, a built UI is also served at ``/``
    (single origin) — registered last, so every API route keeps priority."""
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
        # NOT a contract field: HealthResponse is unchanged and a plain-object
        # parse strips this, which is the proof (docs/decisions.md 2026-07-28).
        # It carries presence + a masked hint per provider, never key material,
        # and is what the UI feature-detects the credential routes on.
        payload["credentials"] = credentials.advertise()
        return _json(request, 200, payload)

    # PUT /credentials {provider, apiKey} — store a provider key (204).
    # DELETE /credentials/{provider} — remove it (204, idempotent).
    #
    # There is deliberately NO GET on either: the store is WRITE-ONLY, so no
    # route can serve key material back and /health's masked hint is the only
    # readable trace a stored key has. aiohttp answers 405 for the missing
    # method, which is the honest answer — the resource exists, reading is not
    # one of the things it does.
    async def put_credentials(request: web.Request) -> web.Response:
        if not _is_local_client(request):
            # Before any body parsing: a rebound page's key must not even be read.
            return _error(request, 403, "forbidden")
        try:
            body = await _read_body(request)
        except json.JSONDecodeError:
            return _error(request, 400, "invalid credential request")
        # A literal `null` body parses to None, and reading .get off it would
        # raise into a 500 — a client mistake answers 400, not "internal error".
        if not isinstance(body, dict):
            return _error(request, 400, "invalid credential request")
        # The error strings come from the store and are fixed: a rejection never
        # echoes the submitted key back in the response body.
        failure = credentials.set_key(body.get("provider"), body.get("apiKey"))
        if failure is not None:
            return _error(request, failure.status, failure.error)
        return web.Response(status=204, headers=_cors(request))

    async def delete_credentials(request: web.Request) -> web.Response:
        if not _is_local_client(request):
            return _error(request, 403, "forbidden")
        failure = credentials.delete_key(request.match_info["provider"])
        if failure is not None:
            return _error(request, failure.status, failure.error)
        return web.Response(status=204, headers=_cors(request))

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
        state.save_profile(body)
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
    app.router.add_route("PUT", "/credentials", put_credentials)
    app.router.add_delete("/credentials/{provider}", delete_credentials)
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
    if ui_root is not None:
        add_ui_routes(app, ui_root)
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
        (BENCH=fake|agent; wins over the saved ones on a shared id)
    BOARDEX_STATE_DIR=<dir> — where saved profiles + provider keys rest
        (default ~/.boardex)
    AGENT_MODELS=<csv> — LiteLLM model strings advertised via capabilities (BENCH=agent)
    AGENT_MAX_TURNS=<n> — agent turn budget per run (BENCH=agent, default 60)
    """
    # Provider key store: the providers it will hold a key for are the ones the
    # advertised models name (AGENT_MODELS), and any provider whose standard env
    # var is already exported boots configured — env stays a working fallback,
    # so an existing setup behaves exactly as it did. Configured for every BENCH,
    # not just agent: the dashboard's key path has to work before anyone
    # switches over, and a fake-bench runner is what a new user meets first.
    credentials.configure()
    # The one place that opts state into disk: a RunnerApp built directly (every
    # test harness) stays purely in-memory. ~/.boardex/profiles.json, loaded
    # here and written through on every save.
    profile_store = persistence.ProfileStore(
        persistence.state_dir() / persistence.PROFILES_FILE
    )

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

        max_turns = int(os.environ.get("AGENT_MAX_TURNS", "60"))
        return RunnerApp(
            # One AgentBench per run — never a shared instance (audit HIGH-1).
            bench_factory=lambda: AgentBench(max_turns=max_turns),
            clock_factory=Clock,
            recorder=recorder,
            engine_cls=AgentRunEngine,
            models=agent_models_from_env(),
            bench_status=agent_bench_status(),
            board_profiles=_board_profiles_from_env(),
            profile_store=profile_store,
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
            profile_store=profile_store,
        )

    return RunnerApp(
        bench_factory=lambda: FakeBench(fail_variant=fail_variant),
        clock_factory=lambda: VirtualClock(speed=speed, dilation=pacing),
        recorder=recorder,
        board_profiles=_board_profiles_from_env(),
        profile_store=profile_store,
    )


def main() -> None:
    port = int(os.environ.get("PORT", str(DEFAULT_PORT)))
    host = os.environ.get("HOST", "127.0.0.1")
    # BOARDEX_SERVE_UI=<dir> — serve a built UI bundle at / from this same
    # origin (see static_ui). Unset means API only, exactly as before.
    ui_root = ui_root_from_env()
    state = state_from_env()
    app = build_app(state, ui_root=ui_root)
    print(f"boardex-runner (real) listening on http://{host}:{port}")
    if ui_root is not None:
        print(f"boardex-runner serving UI from {ui_root}")
    web.run_app(app, host=host, port=port, print=None)


if __name__ == "__main__":
    main()
