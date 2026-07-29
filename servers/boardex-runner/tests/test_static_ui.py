"""The embedded-UI static route (BOARDEX_SERVE_UI): MIME, SPA fallback, API priority.

Wire-level against a real listening runner — no browser. The bundle is a
three-file stand-in for a Vite build (index.html + a hashed js/css pair), which
is all the route's contract depends on.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any

import aiohttp
import pytest
from aiohttp import web
from yarl import URL

from boardex_runner.artifacts import ArtifactStore
from boardex_runner.clock import VirtualClock
from boardex_runner.fake_bench import FakeBench
from boardex_runner.server import RunnerApp, build_app
from boardex_runner.static_ui import ui_root_from_env

from conftest import run

HTML_ACCEPT = {"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}
INDEX_BODY = "<!doctype html><title>Boardex</title><div id=root></div>"


def make_bundle(tmp_path: Path) -> Path:
    root = tmp_path / "ui"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text(INDEX_BODY, encoding="utf-8")
    (root / "assets" / "index-abc123.js").write_text("export const x = 1;\n", encoding="utf-8")
    (root / "assets" / "index-abc123.css").write_text(":root{--x:1}\n", encoding="utf-8")
    (root / "assets" / "inter-latin.woff2").write_bytes(b"wOF2fake")
    return root


class UiHarness:
    """A listening runner with the UI bundle mounted."""

    def __init__(self, ui_root: Path | None) -> None:
        self.state = RunnerApp(
            bench_factory=lambda: FakeBench(),
            clock_factory=lambda: VirtualClock(speed=2000.0),
            artifacts=ArtifactStore(),
        )
        self.ui_root = ui_root
        self.base = ""

    async def __aenter__(self) -> "UiHarness":
        self.runner = web.AppRunner(build_app(self.state, ui_root=self.ui_root))
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.base = f"http://127.0.0.1:{self.runner.addresses[0][1]}"
        self.session = aiohttp.ClientSession()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.session.close()
        for engine in self.state.runs.values():
            engine.dispose()
        await self.runner.cleanup()

    def get(self, path: str, **kwargs: Any) -> Any:
        return self.session.get(self.base + path, **kwargs)

    def get_raw(self, path: str, **kwargs: Any) -> Any:
        """GET without client-side normalization — the request line goes out
        exactly as written, so an encoded traversal actually reaches the
        server instead of being collapsed by yarl before it is sent."""
        return self.session.get(URL(self.base + path, encoded=True), **kwargs)


def test_serves_index_and_assets_with_correct_mime(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with UiHarness(make_bundle(tmp_path)) as h:
            async with h.get("/", headers=HTML_ACCEPT) as res:
                assert res.status == 200
                assert res.headers["Content-Type"].startswith("text/html")
                assert "id=root" in await res.text()
                # index.html names hashed bundles: it must never be cached.
                assert res.headers["Cache-Control"] == "no-cache"

            async with h.get("/assets/index-abc123.js") as res:
                assert res.status == 200
                assert res.headers["Content-Type"].startswith("text/javascript")
                assert "immutable" in res.headers["Cache-Control"]

            async with h.get("/assets/index-abc123.css") as res:
                assert res.headers["Content-Type"].startswith("text/css")

            async with h.get("/assets/inter-latin.woff2") as res:
                assert res.headers["Content-Type"] == "font/woff2"

    run(scenario())


def test_spa_fallback_serves_index_for_client_routes(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with UiHarness(make_bundle(tmp_path)) as h:
            for path in ("/demo", "/settings", "/runs/run_xyz", "/runs/run_xyz/evidence", "/boards/new"):
                async with h.get(path, headers=HTML_ACCEPT) as res:
                    assert res.status == 200, path
                    assert res.headers["Content-Type"].startswith("text/html"), path
                    assert "id=root" in await res.text(), path

    run(scenario())


def test_api_routes_keep_priority_over_the_catch_all(tmp_path: Path) -> None:
    """Even with an HTML Accept header, /health is the API's, not the UI's."""

    async def scenario() -> None:
        async with UiHarness(make_bundle(tmp_path)) as h:
            async with h.get("/health", headers=HTML_ACCEPT) as res:
                assert res.status == 200
                assert res.headers["Content-Type"].startswith("application/json")
                assert (await res.json())["runnerKind"] == "real"

            async with h.get("/bench", headers=HTML_ACCEPT) as res:
                assert res.headers["Content-Type"].startswith("application/json")

            async with h.get("/runs", headers=HTML_ACCEPT) as res:
                assert (await res.json()) == []

            # A known API route's own 404 survives the fallback: the run does
            # not exist, and the UI must see that, not an HTML document.
            async with h.get("/runs/run_missing/events", headers=HTML_ACCEPT) as res:
                assert res.status == 404
                assert (await res.json())["error"] == "run not found"

    run(scenario())


def test_non_html_request_for_an_unknown_path_gets_a_json_404(tmp_path: Path) -> None:
    """Feature detection stays honest: an unimplemented optional route 404s.

    The UI probes routes like GET /documents/{id} (v2.1) and treats 404 as
    "this runner has no such capability". Answering those with index.html would
    hand a markdown reader an HTML document instead.
    """

    async def scenario() -> None:
        async with UiHarness(make_bundle(tmp_path)) as h:
            for path in ("/documents/doc_datasheet", "/assets/missing.js", "/nope"):
                async with h.get(path, headers={"Accept": "application/json"}) as res:
                    assert res.status == 404, path
                    assert res.headers["Content-Type"].startswith("application/json"), path

            # `/` is the exception: the app's front door answers whoever asks
            # (a bare `curl localhost:4380` should see the app, not a 404).
            async with h.get("/", headers={"Accept": "*/*"}) as res:
                assert res.status == 200
                assert res.headers["Content-Type"].startswith("text/html")

    run(scenario())


def test_the_ui_catch_all_cannot_become_a_credential_read_back(tmp_path: Path) -> None:
    """Cross-feature seam: the UI catch-all + the write-only key store.

    The store's whole property is that NO route serves key material back
    (credentials.py). The catch-all answers GETs the API leaves unclaimed — and
    ``/credentials`` is exactly such a path, since it implements only PUT — so
    it must be pinned that what it answers with is the app document or a 404,
    never anything key-derived, and never a 200 JSON body that could read as a
    read-back route existing.
    """
    from boardex_runner import credentials

    credentials.configure(["openrouter/anthropic/claude-sonnet-4.6"])
    assert credentials.set_key("openrouter", "sk-or-v1-SECRETKEYMATERIAL0001") is None

    async def scenario() -> None:
        async with UiHarness(make_bundle(tmp_path)) as h:
            for accept in ("application/json", "text/html", "*/*"):
                async with h.get("/credentials", headers={"Accept": accept}) as res:
                    body = await res.text()
                    assert "SECRETKEYMATERIAL0001" not in body, accept
                    if "text/html" in accept:
                        # The SPA document — carries nothing about the store.
                        assert res.status == 200
                        assert res.headers["Content-Type"].startswith("text/html")
                    else:
                        assert res.status == 404, accept

            # The hint is the only readable trace, and it lives on /health.
            async with h.get("/health") as res:
                assert (await res.json())["credentials"] == [
                    {"provider": "openrouter", "configured": True, "hint": "…0001"}
                ]

    try:
        run(scenario())
    finally:
        credentials.configure([])


def test_traversal_out_of_the_bundle_is_refused(tmp_path: Path) -> None:
    """A REAL traversal, delivered past the client's normalization.

    ``session.get("/../secret.txt")`` is normalized away by the client and never
    reaches the server, so the encoded form is sent with ``encoded=True``: the
    router then hands the handler a decoded ``../secret.txt``, which is exactly
    the input the root re-check exists for. 404 is asserted specifically — an
    absent secret is not enough, because a 500 also lacks the secret while
    meaning the resolver blew up on the way.
    """
    secret = tmp_path / "secret.txt"
    secret.write_text("do not serve me", encoding="utf-8")

    async def scenario() -> None:
        async with UiHarness(make_bundle(tmp_path)) as h:
            for path in (
                "/%2e%2e%2fsecret.txt",
                "/..%2fsecret.txt",
                "/assets%2f..%2f..%2fsecret.txt",
            ):
                async with h.get_raw(path, headers={"Accept": "application/json"}) as res:
                    assert res.status == 404, f"{path} -> {res.status}"
                    assert "do not serve me" not in await res.text(), path

    run(scenario())


@pytest.mark.skipif(sys.platform == "win32", reason="symlink creation needs privileges on Windows")
def test_a_symlink_pointing_out_of_the_bundle_is_refused(tmp_path: Path) -> None:
    """The bundle is a directory of files, not a set of pointers to anywhere.

    A symlink is resolved before the root re-check, so a link planted inside
    assets/ that aims at a file outside the bundle refuses like any other
    traversal — the check is on where the path LANDS, not on how it was spelled.
    """
    secret = tmp_path / "secret.txt"
    secret.write_text("do not serve me", encoding="utf-8")
    root = make_bundle(tmp_path)
    (root / "assets" / "escape.txt").symlink_to(secret)

    async def scenario() -> None:
        async with UiHarness(root) as h:
            async with h.get("/assets/escape.txt", headers={"Accept": "application/json"}) as res:
                assert res.status == 404
                assert "do not serve me" not in await res.text()

    run(scenario())


def test_paths_the_filesystem_itself_rejects_are_404s_not_500s(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A null byte and an over-long segment are "no such file", not a fault.

    Both raise out of pathlib (ValueError / OSError ENAMETOOLONG). Unhandled,
    aiohttp answers 500 and logs a traceback for what is a malformed request —
    noise in the operator's console that reads like the runner broke.
    """
    long_segment = "a" * 400

    async def scenario() -> None:
        async with UiHarness(make_bundle(tmp_path)) as h:
            for path in ("/%00.txt", f"/assets/{long_segment}.js", f"/%00{long_segment}"):
                async with h.get_raw(path, headers={"Accept": "application/json"}) as res:
                    assert res.status == 404, f"{path[:24]}… -> {res.status}"

    with caplog.at_level(logging.ERROR):
        run(scenario())
    assert not [record for record in caplog.records if record.exc_info], (
        "a malformed path logged a traceback: "
        f"{[record.getMessage() for record in caplog.records]}"
    )


def test_no_ui_root_leaves_the_api_alone(tmp_path: Path) -> None:
    """A bare boardex-runner is unchanged: no GET catch-all, no UI, no HTML.

    405 (not 404) is what the API-only runner has always answered at `/`: the
    pre-existing OPTIONS catch-all matches the path but not the method. The
    point of the assertion is that nothing serves a document.
    """

    async def scenario() -> None:
        async with UiHarness(None) as h:
            async with h.get("/", headers=HTML_ACCEPT) as res:
                assert res.status == 405
                assert "text/html" not in res.headers.get("Content-Type", "")
            async with h.get("/health") as res:
                assert res.status == 200

    run(scenario())


def test_ui_root_from_env_unset_none_and_invalid(tmp_path: Path) -> None:
    assert ui_root_from_env({}) is None
    assert ui_root_from_env({"BOARDEX_SERVE_UI": "  "}) is None

    root = make_bundle(tmp_path)
    assert ui_root_from_env({"BOARDEX_SERVE_UI": str(root)}) == root.resolve()

    # A path with no index.html is a configuration error, not a silent no-op.
    with pytest.raises(SystemExit):
        ui_root_from_env({"BOARDEX_SERVE_UI": str(tmp_path / "not-a-bundle")})
