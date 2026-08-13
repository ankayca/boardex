"""Provider credentials: the store's rules, the HTTP surface, and the invariant
the whole feature rests on — a stored key is unreachable from every other surface.

Ported alongside ``boardex_runner/credentials.py`` from the mock runner's
reference implementation and its suite (tools/mock-runner/src/server.test.ts).
"""

from __future__ import annotations

import asyncio
import json
import logging
import stat
import sys
from typing import Any, Iterator

import aiohttp
import pytest

from boardex_runner import credentials, persistence
from boardex_runner.persistence import ProfileStore
from boardex_runner.provider import LiteLLMProvider

from conftest import run
from test_provider import _FakeLiteLLM
from test_server_http import Harness

MODEL = "openrouter/anthropic/claude-sonnet-4.6"


@pytest.fixture(autouse=True)
def configured_store(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """The store is module state: configure it per test and empty it after, so
    no test can inherit another's key. The provider's env var is cleared first —
    a developer with OPENROUTER_API_KEY exported would otherwise seed the store
    and these tests would pass or fail by whose shell they ran in."""
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    credentials.configure([MODEL])
    yield
    credentials.configure([])


# -- the store ------------------------------------------------------------------------


def test_hint_masks_to_the_last_four_only_above_the_floor() -> None:
    # The floor is the point where four characters stop being most of the key.
    # Below it the hint is a bare ellipsis: still a truthful "something is set",
    # with nothing recoverable in it.
    assert credentials.mask_key("1234567") == "…"
    assert credentials.mask_key("12345678") == "…5678"
    assert credentials.mask_key("123456789") == "…6789"
    assert credentials.mask_key("") == "…"


def test_providers_are_derived_from_the_advertised_models() -> None:
    assert credentials.providers_from_models(
        [MODEL, "openrouter/openai/gpt-5", "anthropic/claude-sonnet-4-6"]
    ) == ["openrouter", "anthropic"]
    # A BARE model string derives nothing — naming its provider needs LiteLLM's
    # tables, which this module deliberately does not import (see the docstring).
    assert credentials.providers_from_models(["claude-sonnet-4-6"]) == []
    assert credentials.provider_for_model("claude-sonnet-4-6") is None
    # The env-var mapping generalizes with AGENT_MODELS rather than hardcoding.
    assert credentials.env_var_for("openrouter") == "OPENROUTER_API_KEY"
    assert credentials.env_var_for("anthropic") == "ANTHROPIC_API_KEY"


def test_env_boot_dashboard_override_and_remove_reverting_to_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The full sequence an operator with an exported key actually walks, with
    the two views checked at every step: what /health advertises and what a run
    would spend must never disagree."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-from-the-environment")
    credentials.configure([MODEL])

    # Boot: seeded from env, so the UI never offers to set a key already set.
    assert credentials.advertise() == [
        {"provider": "openrouter", "configured": True, "hint": "…ment"}
    ]
    assert credentials.resolve_key(MODEL) == "sk-or-v1-from-the-environment"

    # Paste in the dashboard: the hint flips and the store wins.
    assert credentials.set_key("openrouter", "sk-or-v1-from-the-dashboard") is None
    assert credentials.advertise() == [
        {"provider": "openrouter", "configured": True, "hint": "…oard"}
    ]
    assert credentials.resolve_key(MODEL) == "sk-or-v1-from-the-dashboard"

    # Remove: what it discards is the DASHBOARD's key. The exported one is still
    # there and still what runs will spend, so the store re-seeds and keeps
    # saying so — configured, with the env key's hint back. Advertising
    # `configured: false` here would be the store claiming a run has no key
    # while the very next run bills the exported one.
    assert credentials.delete_key("openrouter") is None
    assert credentials.advertise() == [
        {"provider": "openrouter", "configured": True, "hint": "…ment"}
    ]
    assert credentials.resolve_key(MODEL) == "sk-or-v1-from-the-environment"

    # A model whose provider is underivable resolves nothing at all.
    assert credentials.resolve_key("claude-sonnet-4-6") is None


def test_remove_clears_the_slot_when_no_env_key_backs_it() -> None:
    """The other half of the ruling: with nothing exported, Remove really does
    leave the provider unconfigured — re-seeding is not a refusal to delete."""
    assert credentials.set_key("openrouter", "sk-or-v1-dashboard-only") is None
    assert credentials.delete_key("openrouter") is None
    assert credentials.advertise() == [{"provider": "openrouter", "configured": False}]
    assert credentials.resolve_key(MODEL) is None


def test_padded_env_value_yields_one_key_on_both_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A trailing newline in an exported variable (``export K=$(cat key.txt)``)
    must not make the advertised hint and the sent key describe different
    strings: seeding, re-seeding and the resolve fallback all strip identically."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "  sk-or-v1-padded-3b7f\n")
    credentials.configure([MODEL])
    assert credentials.resolve_key(MODEL) == "sk-or-v1-padded-3b7f"
    assert credentials.advertise()[0]["hint"] == "…3b7f"

    # The resolve fallback path (store empty, env present) strips the same way.
    credentials._keys.clear()
    assert credentials.resolve_key(MODEL) == "sk-or-v1-padded-3b7f"

    # And so does the re-seed after a Remove.
    assert credentials.set_key("openrouter", "sk-or-v1-dashboard") is None
    assert credentials.delete_key("openrouter") is None
    assert credentials.resolve_key(MODEL) == "sk-or-v1-padded-3b7f"
    assert credentials.advertise()[0]["hint"] == "…3b7f"


def test_unset_env_leaves_the_store_empty_and_resolution_none() -> None:
    assert credentials.advertise() == [{"provider": "openrouter", "configured": False}]
    assert credentials.resolve_key(MODEL) is None


def test_advertise_is_the_whole_readable_surface() -> None:
    key = "sk-or-v1-store-surface-8a71c3"
    assert credentials.set_key("openrouter", key) is None
    # Presence and a masked tail — the key itself is nowhere in what is served.
    assert key not in json.dumps(credentials.advertise())
    assert credentials.advertise() == [
        {"provider": "openrouter", "configured": True, "hint": "…71c3"}
    ]


def test_store_validation_rejects_unknown_providers_and_bad_keys() -> None:
    # Identity before payload: a key sent at a provider we do not have is a 404
    # about the route, never a 400 claiming the key was malformed.
    unknown = credentials.set_key("anthropic", "sk-ant-whatever")
    assert unknown is not None and unknown.status == 404
    for bad in ("", "   ", 42, None, {"apiKey": "x"}):
        failure = credentials.set_key("openrouter", bad)
        assert failure is not None and failure.status == 400
    assert credentials.advertise()[0]["configured"] is False


def test_provider_resolves_the_key_at_call_time_not_at_construction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The property that makes the dashboard usable without a restart: the key
    is looked up per request, so one pasted after the provider was constructed
    is on the very next call."""
    fake = _FakeLiteLLM(supports_caching=False)
    monkeypatch.setitem(sys.modules, "litellm", fake)
    messages = [{"role": "user", "content": "bring up the BME280"}]
    # Constructed while nothing is configured — the old code captured here.
    provider = LiteLLMProvider(MODEL, max_tokens=64)

    asyncio.run(provider.complete(messages, tools=[]))
    # Nothing to pass: LiteLLM reads the environment itself, exactly as before.
    assert "api_key" not in fake.captured

    credentials.set_key("openrouter", "sk-or-v1-pasted-mid-session")
    asyncio.run(provider.complete(messages, tools=[]))
    assert fake.captured["api_key"] == "sk-or-v1-pasted-mid-session"

    # Store first, env second: removing the pasted key falls back, still per call.
    credentials.delete_key("openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-from-the-environment")
    asyncio.run(provider.complete(messages, tools=[]))
    assert fake.captured["api_key"] == "sk-or-v1-from-the-environment"


# -- the HTTP surface -----------------------------------------------------------------


def _put(
    h: Harness, body: Any, raw: str | None = None, headers: dict[str, str] | None = None
) -> Any:
    assert h.session
    if raw is not None:
        merged = {"Content-Type": "application/json", **(headers or {})}
        return h.session.put(h.base + "/credentials", data=raw, headers=merged)
    return h.session.put(h.base + "/credentials", json=body, headers=headers or {})


def test_credentials_routes_store_reflect_and_remove() -> None:
    async def scenario() -> None:
        async with Harness() as h:
            assert h.session

            async def advertised() -> dict[str, Any]:
                health = await h.get_json("/health")
                return health["credentials"][0]

            assert await advertised() == {"provider": "openrouter", "configured": False}

            key = "sk-or-v1-http-surface-0000f92a"
            async with _put(h, {"provider": "openrouter", "apiKey": key}) as res:
                assert res.status == 204
            # Reflection: presence plus the masked tail, never key material.
            assert await advertised() == {
                "provider": "openrouter",
                "configured": True,
                "hint": "…f92a",
            }

            # Unknown provider -> 404 (the route, not the payload). Empty or
            # non-string key -> 400. A null / non-object body -> 400, never 500.
            async with _put(h, {"provider": "anthropic", "apiKey": key}) as res:
                assert res.status == 404
            for body in ({"provider": "openrouter", "apiKey": ""},
                         {"provider": "openrouter", "apiKey": 42},
                         {"provider": "openrouter"}):
                async with _put(h, body) as res:
                    assert res.status == 400
            for raw in ("null", '"not an object"', "[]", "{not json"):
                async with _put(h, None, raw=raw) as res:
                    assert res.status == 400

            # None of the rejections disturbed the stored key.
            assert (await advertised())["hint"] == "…f92a"

            # DELETE is idempotent so the dashboard's Remove can be pressed twice.
            async with h.session.delete(h.base + "/credentials/anthropic") as res:
                assert res.status == 404
            async with h.session.delete(h.base + "/credentials/openrouter") as res:
                assert res.status == 204
            assert await advertised() == {"provider": "openrouter", "configured": False}
            async with h.session.delete(h.base + "/credentials/openrouter") as res:
                assert res.status == 204

    run(scenario())


def test_delete_answers_500_when_the_removal_cannot_be_persisted() -> None:
    """The route half of the delete ruling. 204 means "the key is gone"; if the
    removal did not reach disk, the next boot brings it back and goes on
    spending, so the runner says so instead."""

    async def scenario() -> None:
        async with Harness() as h:
            assert h.session
            key = "sk-or-v1-removal-must-persist"
            async with _put(h, {"provider": "openrouter", "apiKey": key}) as res:
                assert res.status == 204

            real_replace = persistence.os.replace
            failing = {"now": True}

            def maybe_boom(src: Any, dst: Any) -> Any:
                if failing["now"]:
                    raise OSError(30, "Read-only file system")
                return real_replace(src, dst)

            persistence.os.replace = maybe_boom  # restored below, not via undo
            try:
                async with h.session.delete(h.base + "/credentials/openrouter") as res:
                    assert res.status == 500
                    assert await res.json() == {"error": "could not remove credential"}
            finally:
                failing["now"] = False
                persistence.os.replace = real_replace

            # And the store still says what the file says: still configured.
            health = await h.get_json("/health")
            assert health["credentials"][0]["configured"] is True

            # With the disk working, the same Remove lands.
            async with h.session.delete(h.base + "/credentials/openrouter") as res:
                assert res.status == 204

    run(scenario())


def test_credentials_have_no_read_back_route() -> None:
    """The property the whole design rests on: nothing serves a key back. A GET
    is simply not a method these resources have, and none may be added."""

    async def scenario() -> None:
        async with Harness() as h:
            assert h.session
            async with _put(h, {"provider": "openrouter", "apiKey": "sk-or-v1-no-readback"}):
                pass
            async with h.session.get(h.base + "/credentials") as res:
                assert res.status == 405
            async with h.session.get(h.base + "/credentials/openrouter") as res:
                assert res.status == 405

    run(scenario())


def test_credentials_routes_reject_non_local_host_and_origin() -> None:
    """The DNS-rebinding guard: a page in the operator's browser that rebinds its
    own hostname to 127.0.0.1 reaches this port with the browser's blessing.
    Host and Origin are both pinned, and the rejection lands before any body is
    read — the attacker's key never even gets parsed."""

    async def scenario() -> None:
        async with Harness() as h:
            assert h.session
            body = {"provider": "openrouter", "apiKey": "sk-or-v1-attacker-key"}

            # A rebound hostname: the request reaches us, the Host header does not
            # name loopback.
            async with _put(h, body, headers={"Host": "evil.example.com"}) as res:
                assert res.status == 403
            # A cross-origin page with a legitimate Host (the browser sends the
            # real one) is caught by Origin instead.
            async with _put(h, body, headers={"Origin": "https://evil.example.com"}) as res:
                assert res.status == 403
            # ORDERING, not just outcome: the guard runs BEFORE the body is
            # read. A malformed body from a rebound host still answers 403 —
            # a 400 here would mean the attacker's payload reached the parser
            # before the runner decided whether to listen to it at all.
            async with _put(
                h, None, raw="{not json", headers={"Host": "evil.example.com"}
            ) as res:
                assert res.status == 403
            # Same for a body that is well-formed JSON but the wrong shape: the
            # 400 that a local client would get is never the answer here.
            async with _put(h, None, raw="null", headers={"Host": "evil.example.com"}) as res:
                assert res.status == 403

            # DELETE is guarded identically — clearing a key silently breaks
            # every run, which is an attack too.
            for headers in ({"Host": "evil.example.com"}, {"Origin": "http://evil.example.com"}):
                async with h.session.delete(
                    h.base + "/credentials/openrouter", headers=headers
                ) as res:
                    assert res.status == 403

            # Nothing was stored by any of it.
            health = await h.get_json("/health")
            assert health["credentials"] == [{"provider": "openrouter", "configured": False}]

            # A localhost Origin is the normal case and still works.
            async with _put(h, body, headers={"Origin": "http://localhost:5173"}) as res:
                assert res.status == 204

            # The asymmetry is deliberate: the other routes are unchanged by this
            # guard and still answer a non-local Host.
            async with h.session.get(
                h.base + "/health", headers={"Host": "evil.example.com"}
            ) as res:
                assert res.status == 200

    run(scenario())


def test_stored_key_never_reaches_any_served_byte(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Set a key, drive a full run, then grep the RAW BYTES of everything served.

    Wire bytes, not parsed views: schema parsing STRIPS unknown keys, so a key
    echoed into a non-contract field would be laundered by the parse — passing a
    grep over the parsed events while still going out on the socket and the
    replay. Anything a client can read is checked here unparsed.

    Persistence widened what "anything a client can read" means, so the grep
    widened with it: the key now rests in a file, and the two new places it
    could wrongly turn up are the OTHER state file (profiles.json, which is
    world-readable by design) and the log lines the save path emits. Both are
    checked below, on the same canary.
    """

    async def scenario() -> None:
        # A store, so the save path this test greps actually runs.
        store = ProfileStore(persistence.state_dir() / persistence.PROFILES_FILE)
        async with Harness(profile_store=store) as h:
            assert h.session
            key = "sk-or-v1-leak-canary-abcdef123456"
            async with _put(h, {"provider": "openrouter", "apiKey": key}) as res:
                assert res.status == 204

            # A profile save after the key is set: the write-through that could
            # carry a key into the wrong file happens here, not at boot.
            profiles = await h.get_json("/board-profiles")
            saved = dict(profiles[0], name="Bench with a key configured")
            assert (await h.post("/board-profiles", saved)).status == 200

            run_id = await h.create_run()
            ws = await h.session.ws_connect(f"{h.base}/ws?runId={run_id}")
            frames: list[str] = []

            async def collect() -> None:
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        break
                    # msg.data is the frame exactly as it arrived, before parse.
                    frames.append(msg.data)
                    if json.loads(msg.data)["type"] in (
                        "run.completed",
                        "run.failed",
                        "run.stopped",
                    ):
                        break

            collector = asyncio.ensure_future(collect())
            events = await h.drive_to_terminal(run_id)
            await asyncio.wait_for(collector, timeout=10)
            await ws.close()

            assert len(events) > 1
            assert frames
            for frame in frames:
                assert key not in frame

            # The HTTP replay body, unparsed.
            async with h.session.get(f"{h.base}/runs/{run_id}/events?afterSeq=0") as res:
                replay = await res.text()
            assert replay
            assert key not in replay

            # Every artifact the run produced, fetched by reference as the UI does.
            artifact_ids = [
                e["payload"]["artifact"]["id"]
                for e in events
                if e["type"] == "artifact.created"
            ]
            assert artifact_ids
            for artifact_id in artifact_ids:
                for path in (f"/artifacts/{artifact_id}", f"/artifacts/{artifact_id}/meta"):
                    async with h.session.get(h.base + path) as res:
                        assert key not in await res.text()

            # Error bodies, including the ones the credential routes produce
            # themselves — a rejection must never echo the submitted key back.
            probes: list[Any] = [
                _put(h, {"provider": "anthropic", "apiKey": key}),
                _put(h, {"provider": "openrouter", "apiKey": ""}),
                _put(h, {"provider": "openrouter", "apiKey": key},
                     headers={"Host": "evil.example.com"}),
                h.session.get(h.base + "/credentials"),
                h.session.get(h.base + "/runs/run_does_not_exist/events?afterSeq=0"),
                h.session.get(h.base + "/artifacts/art_does_not_exist"),
                h.session.get(h.base + "/health"),
                h.session.get(h.base + "/runs"),
                h.session.get(h.base + "/bench"),
            ]
            for probe in probes:
                async with probe as res:
                    assert key not in await res.text()

            # THE ON-DISK SURFACE. A key belongs in credentials.json and nowhere
            # else: profiles.json is world-readable by design (it holds repo
            # paths and bench wiring), so a key reaching it would undo the 0600
            # the other file is written with.
            state_dir = persistence.state_dir()
            profiles_json = state_dir / persistence.PROFILES_FILE
            assert profiles_json.exists()  # the save above really did write
            assert key not in profiles_json.read_text(encoding="utf-8")
            # Everything else the runner dropped in the state directory, too —
            # temp files, corrupt-file copies, anything a future writer adds.
            for path in state_dir.rglob("*"):
                if path.is_file() and path.name != persistence.CREDENTIALS_FILE:
                    assert key not in path.read_text(encoding="utf-8", errors="ignore"), path
            # The one file that legitimately holds it is owner-only.
            creds_json = state_dir / persistence.CREDENTIALS_FILE
            assert key in creds_json.read_text(encoding="utf-8")
            if sys.platform != "win32":
                assert stat.S_IMODE(creds_json.stat().st_mode) == 0o600

            # THE SAVE PATH'S FAILURE LOG. A warning is where a key most easily
            # escapes: the value is right there in the caller's hand, and
            # "could not write <this> to <path>" is the natural sentence to
            # reach for. Force the failure and check what it said.
            real_replace = persistence.os.replace
            failing = {"now": True}

            def maybe_boom(src: Any, dst: Any) -> Any:
                # A switch, not monkeypatch.undo(): undo() would also revert the
                # conftest fixture's BOARDEX_STATE_DIR and repoint the rest of
                # this test at the developer's real home directory.
                if failing["now"]:
                    raise OSError(28, "No space left on device")
                return real_replace(src, dst)

            monkeypatch.setattr(persistence.os, "replace", maybe_boom)
            failed_key = "sk-or-v1-leak-canary-on-a-full-disk-77b1"
            async with _put(h, {"provider": "openrouter", "apiKey": failed_key}) as res:
                # Best-effort persistence: the key IS set for this process, which
                # is all the 204 claims (delete is the half that must surface).
                assert res.status == 204
            failing["now"] = False
            assert any("could not write" in r.getMessage() for r in caplog.records)
            # The write failed, so the file still holds the previous key —
            # unchanged, not truncated to something partial.
            assert key in creds_json.read_text(encoding="utf-8")

            # And no log record from any of it carries key material. The save
            # path logs paths only — a warning that helpfully included the value
            # it could not write would put the key in every operator's terminal.
            for record in caplog.records:
                assert key not in record.getMessage()
                assert failed_key not in record.getMessage()

    with caplog.at_level(logging.DEBUG):
        run(scenario())
