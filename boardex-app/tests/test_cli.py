"""`boardex up`: process management and the single-origin serve, at the wire.

The integration tests launch the real CLI as a child process against a real
runner and talk HTTP to it — no browser. They skip when boardex-runner is not
importable (the CLI's own preflight covers that case in its unit test).
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from boardex_app.cli import (
    browse_host,
    build_parser,
    main,
    probe_health,
    resolve_bench,
    runner_env,
    stop_process,
    wait_for_health,
)
from boardex_app.ui_assets import ui_bundle_dir

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
HAS_RUNNER = importlib.util.find_spec("boardex_runner") is not None
needs_runner = pytest.mark.skipif(not HAS_RUNNER, reason="boardex-runner is not installed")
needs_signals = pytest.mark.skipif(
    sys.platform == "win32", reason="SIGINT cannot be delivered to another process on Windows"
)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_get(url: str, accept: str = "text/html", timeout: float = 5.0) -> tuple[int, str, str]:
    request = urllib.request.Request(url, headers={"Accept": accept})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.headers.get("Content-Type", ""), response.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, err.headers.get("Content-Type", ""), err.read().decode()


class UpProcess:
    """A `boardex up` child, driven exactly as a terminal would drive it."""

    def __init__(self, *args: str) -> None:
        self.args = args
        self.port = free_port()

    def __enter__(self) -> "UpProcess":
        env = {**os.environ, "PYTHONPATH": str(PACKAGE_ROOT), "PYTHONUNBUFFERED": "1"}
        # Never inherit a developer's own bundle override into the test.
        env.pop("BOARDEX_SERVE_UI", None)
        self.process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "boardex_app.cli",
                "up",
                "--no-open",
                "--port",
                str(self.port),
                *self.args,
            ],
            env=env,
        )
        self.url = f"http://127.0.0.1:{self.port}"
        return self

    def __exit__(self, *exc: object) -> None:
        stop_process(self.process)

    def wait_ready(self, timeout: float = 120.0) -> dict:
        health = wait_for_health(self.url, self.process, timeout=timeout)
        assert health is not None, "the runner never became healthy"
        return health


# -- unit: the pure decisions -----------------------------------------------------------


def test_demo_runs_the_fake_bench_and_plain_up_runs_the_agent_bench() -> None:
    assert resolve_bench(None, demo=False) == "agent"
    assert resolve_bench(None, demo=True) == "fake"
    # An explicit --bench always wins, demo or not.
    assert resolve_bench("real", demo=True) == "real"


def test_browse_host_turns_bind_addresses_into_browsable_ones() -> None:
    assert browse_host("0.0.0.0") == "127.0.0.1"
    assert browse_host("127.0.0.1") == "127.0.0.1"
    assert browse_host("boardex.local") == "boardex.local"


def test_runner_env_passes_the_bundle_bench_and_schemas_through(tmp_path: Path) -> None:
    schemas = tmp_path / "contract-schema"
    env = runner_env(
        host="0.0.0.0", port=4390, bench="fake", ui_root=tmp_path, schema_dir=schemas, base_env={}
    )
    assert env == {
        "HOST": "0.0.0.0",
        "PORT": "4390",
        "BENCH": "fake",
        "BOARDEX_SERVE_UI": str(tmp_path),
        "BOARDEX_CONTRACT_SCHEMA_DIR": str(schemas),
    }
    # No bundle: the runner is launched API-only rather than pointed at nothing.
    assert "BOARDEX_SERVE_UI" not in runner_env(
        host="127.0.0.1", port=1, bench="agent", ui_root=None, base_env={}
    )


def test_a_developers_own_schema_dir_is_not_overridden(tmp_path: Path) -> None:
    env = runner_env(
        host="127.0.0.1",
        port=1,
        bench="fake",
        ui_root=None,
        schema_dir=tmp_path / "bundled",
        base_env={"BOARDEX_CONTRACT_SCHEMA_DIR": "/my/own/schemas"},
    )
    assert env["BOARDEX_CONTRACT_SCHEMA_DIR"] == "/my/own/schemas"


def test_wait_for_health_gives_up_when_the_runner_dies() -> None:
    class Dead:
        def poll(self) -> int:
            return 1

    assert wait_for_health("http://127.0.0.1:1", Dead(), timeout=5.0) is None  # type: ignore[arg-type]


def test_wait_for_health_times_out_without_a_process() -> None:
    slept: list[float] = []
    assert (
        wait_for_health("http://127.0.0.1:1", None, timeout=0.5, sleep=slept.append) is None
    )
    assert slept, "it should have polled at least once"


def test_probe_health_on_a_dead_port_is_none() -> None:
    assert probe_health(f"http://127.0.0.1:{free_port()}", timeout=0.5) is None


def test_stop_process_kills_a_child_that_ignores_the_ask() -> None:
    # A child that swallows SIGTERM must still be gone when stop_process returns.
    child = subprocess.Popen(
        [sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"]
    )
    started = time.monotonic()
    stop_process(child, grace=1.0)
    assert child.poll() is not None
    assert time.monotonic() - started < 10.0


def test_version_flag_prints_the_package_version(capsys: pytest.CaptureFixture[str]) -> None:
    from boardex_app import __version__

    with pytest.raises(SystemExit) as exit_info:
        main(["--version"])
    assert exit_info.value.code == 0
    assert __version__ in capsys.readouterr().out


def test_bare_boardex_prints_help(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([]) == 0
    out = capsys.readouterr().out
    assert "up" in out and "doctor" in out


def test_up_parses_its_flags() -> None:
    args = build_parser().parse_args(["up", "--demo", "--no-open", "--port", "5000"])
    assert (args.demo, args.no_open, args.port, args.bench) == (True, True, 5000, None)


# -- integration: a real `boardex up` -----------------------------------------------------


@needs_runner
@needs_signals
def test_up_launches_a_healthy_runner_and_stops_cleanly_on_ctrl_c() -> None:
    with UpProcess("--bench", "fake") as up:
        health = up.wait_ready()
        assert health["runnerKind"] == "real"
        assert health["ok"] is True

        # Ctrl-C at the CLI: the CLI must take the runner down with it and exit 0.
        up.process.send_signal(signal.SIGINT)
        assert up.process.wait(timeout=30) == 0

        # And the port is genuinely released — no orphan runner behind it.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and probe_health(up.url, timeout=0.5) is not None:
            time.sleep(0.2)
        assert probe_health(up.url, timeout=0.5) is None
        with socket.socket() as sock:
            # SO_REUSEADDR so the bind proves "nothing is LISTENING here" rather
            # than tripping over the just-closed connections' TIME_WAIT.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", up.port))


@needs_runner
@pytest.mark.skipif(ui_bundle_dir() is None, reason="this install has no embedded UI bundle")
def test_up_serves_the_embedded_ui_from_the_runner_origin() -> None:
    """The deliverable, at the wire: one origin serves the app AND the API."""
    with UpProcess("--bench", "fake") as up:
        up.wait_ready()

        status, content_type, body = http_get(up.url + "/")
        assert status == 200
        assert content_type.startswith("text/html")
        assert 'id="root"' in body

        # A client route (the demo tour) resolves to the same document.
        status, content_type, demo_body = http_get(up.url + "/demo")
        assert (status, demo_body) == (200, body)

        # The API is still the API on that same origin.
        status, content_type, api_body = http_get(up.url + "/health", accept="application/json")
        assert status == 200
        assert content_type.startswith("application/json")
        assert json.loads(api_body)["runnerKind"] == "real"

        # And the document's own module bundle comes back as a script, not a
        # document — followed exactly as the browser would follow it, from the
        # index.html this server just served.
        asset = re.search(r'src="(/assets/[^"]+\.js)"', body)
        assert asset, "the served index.html references no module bundle"
        status, content_type, _ = http_get(up.url + asset.group(1), accept="*/*")
        assert status == 200
        assert content_type.startswith("text/javascript")


@needs_runner
@pytest.mark.skipif(
    ui_bundle_dir() is None, reason="only an installed/bundled tree carries the schemas"
)
def test_a_run_started_from_the_packaged_install_emits_validated_events() -> None:
    """The runner validates every event against the contract schemas, which it
    finds by walking up for a checkout — an installed wheel sits in none. If
    `boardex up` did not hand over the bundled copy, this run would emit
    nothing."""
    with UpProcess("--bench", "fake") as up:
        up.wait_ready()

        request = urllib.request.Request(
            up.url + "/runs",
            data=json.dumps(
                {"taskPrompt": "bring up BME280", "boardProfileId": "bp_fake"}
            ).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            run_id = json.loads(response.read())["runId"]

        deadline = time.monotonic() + 30
        events: list = []
        while time.monotonic() < deadline and not events:
            status, _, body = http_get(up.url + f"/runs/{run_id}/events", accept="application/json")
            assert status == 200
            events = json.loads(body)
            if not events:
                time.sleep(0.2)
        assert events, "the run emitted no events — contract schemas not resolvable?"
        assert events[0]["type"] == "run.created"


def test_up_refuses_cleanly_when_the_runner_is_not_installed(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("boardex_app.cli.runner_missing", lambda: True)
    assert main(["up", "--no-open"]) == 1
    assert "boardex-runner is not installed" in capsys.readouterr().err
