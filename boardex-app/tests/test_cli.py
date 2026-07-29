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

from boardex_app import doctor
from boardex_app.cli import (
    browse_host,
    build_parser,
    main,
    port_available,
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
            # Its own process group, so the harness can reap the whole tree.
            # The CLI is the group leader, so the group id is its pid — captured
            # now, because once it exits there is nothing left to ask.
            start_new_session=os.name != "nt",
        )
        self.pgid = self.process.pid
        self.url = f"http://127.0.0.1:{self.port}"
        return self

    def __exit__(self, *exc: object) -> None:
        stop_process(self.process)
        self.reap_group()

    def reap_group(self, grace: float = 5.0) -> None:
        """Make sure the RUNNER is gone, not just the CLI that started it.

        Stopping the CLI is not the same as stopping what it spawned: the CLI
        exits, the runner is reparented, and the test suite quietly leaves a
        listening server behind for every case it ran. The CLI shutting its own
        runner down is the actual fix (it handles SIGTERM now); this is the
        harness refusing to depend on that being true — a regression there
        should surface as a failing suite guard, not as orphans on the machine.
        """
        if os.name == "nt":  # no process groups to reap
            return
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(self.pgid, sig)
            except (ProcessLookupError, PermissionError):
                return  # the group is empty: nothing survived
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline:
                try:
                    os.killpg(self.pgid, 0)
                except (ProcessLookupError, PermissionError):
                    return
                time.sleep(0.1)

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
@needs_signals
def test_up_stops_the_runner_on_sigterm_too() -> None:
    """The SIGTERM twin of the Ctrl-C test.

    A supervisor, `docker stop`, `kill`, or a test harness stops `boardex up`
    with SIGTERM, not with a keyboard. Unhandled, the CLI dies where it stands
    and leaves its runner holding the port — this asserts the same clean end as
    Ctrl-C: the CLI exits, the runner is gone, the port is free.
    """
    with UpProcess("--bench", "fake") as up:
        up.wait_ready()

        up.process.send_signal(signal.SIGTERM)
        assert up.process.wait(timeout=30) == 0

        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and probe_health(up.url, timeout=0.5) is not None:
            time.sleep(0.2)
        assert probe_health(up.url, timeout=0.5) is None, "the runner outlived the CLI"

        # Nothing left in the group at all — no orphan holding the port quietly.
        with pytest.raises(ProcessLookupError):
            os.killpg(up.pgid, 0)

        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", up.port))


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


# -- launch decisions, without a real runner ---------------------------------------------


class FakeProcess:
    """A spawned runner that is already up and exits 0 when waited on."""

    def __init__(self) -> None:
        self.returncode = 0
        self.terminated = False

    def poll(self) -> int:
        return 0

    def wait(self, timeout: float | None = None) -> int:
        return 0

    def terminate(self) -> None:  # pragma: no cover - poll() says it is gone
        self.terminated = True


def stub_launch(monkeypatch: pytest.MonkeyPatch, *, health: dict | None = None) -> list[str]:
    """Run command_up without spawning anything; return the list of opened URLs."""
    spawned: list[list[str]] = []

    def fake_popen(cmd, **kwargs):  # noqa: ANN001, ANN202
        spawned.append(cmd)
        return FakeProcess()

    opened: list[str] = []
    monkeypatch.setattr("boardex_app.cli.subprocess.Popen", fake_popen)
    monkeypatch.setattr(
        "boardex_app.cli.wait_for_health",
        lambda *a, **k: health if health is not None else {"ok": True, "runnerKind": "real"},
    )
    monkeypatch.setattr("boardex_app.cli.webbrowser.open", lambda url: opened.append(url) or True)
    return opened


def test_up_opens_the_app_the_demo_or_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    port = free_port()
    base = f"http://127.0.0.1:{port}"

    opened = stub_launch(monkeypatch)
    assert main(["up", "--bench", "fake", "--port", str(port)]) == 0
    assert opened == [base], "plain `up` opens the app root"

    opened = stub_launch(monkeypatch)
    assert main(["up", "--demo", "--port", str(port)]) == 0
    assert opened == [f"{base}/demo"], "`up --demo` opens the client-side tour"

    opened = stub_launch(monkeypatch)
    assert main(["up", "--no-open", "--bench", "fake", "--port", str(port)]) == 0
    assert opened == [], "--no-open opens nothing"


def test_the_keyless_advisory_appears_only_where_a_key_is_needed(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Agent bench with no key: one advisory, leading with the dashboard.

    The fake bench calls no provider, so the same advisory there would be noise
    telling a demo user to go configure something they will never use.
    """
    for name in doctor.PROVIDER_KEY_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("AGENT_MODELS", raising=False)
    port = free_port()

    stub_launch(monkeypatch)
    assert main(["up", "--no-open", "--port", str(port)]) == 0
    advisory = " ".join(capsys.readouterr().out.split())
    assert (
        "note no provider key yet — set one at Settings → Model provider in the "
        "page above (or export a key before launch). The UI and the demo need none."
    ) in advisory

    stub_launch(monkeypatch)
    assert main(["up", "--no-open", "--bench", "fake", "--port", str(port)]) == 0
    assert "provider key" not in capsys.readouterr().out

    # And with a key exported, the agent bench says nothing either.
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    stub_launch(monkeypatch)
    assert main(["up", "--no-open", "--port", str(port)]) == 0
    assert "provider key" not in capsys.readouterr().out


def test_up_refuses_an_occupied_port_before_spawning_anything(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """One resolved message, no child, no banner announcing someone else's server."""

    def fail_if_spawned(*args: object, **kwargs: object):  # noqa: ANN202
        raise AssertionError("a runner was spawned onto an occupied port")

    monkeypatch.setattr("boardex_app.cli.subprocess.Popen", fail_if_spawned)

    with socket.socket() as occupant:
        occupant.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        occupant.bind(("127.0.0.1", 0))
        occupant.listen(1)
        port = occupant.getsockname()[1]

        assert main(["up", "--no-open", "--port", str(port)]) == 1
        captured = capsys.readouterr()

    assert f"port {port} is in use" in captured.err
    assert "already running" in captured.err and "--port" in captured.err
    assert "is up:" not in captured.out, "no banner for a server we did not start"


def test_port_available_reads_the_actual_socket_state() -> None:
    port = free_port()
    assert port_available("127.0.0.1", port) is True
    with socket.socket() as occupant:
        occupant.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        occupant.bind(("127.0.0.1", port))
        occupant.listen(1)
        assert port_available("127.0.0.1", port) is False
    # A host that cannot even be resolved must not be reported as occupied.
    assert port_available("no-such-host.invalid", port) is True


def test_up_refuses_cleanly_when_the_runner_is_not_installed(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("boardex_app.cli.runner_missing", lambda: True)
    assert main(["up", "--no-open"]) == 1
    assert "boardex-runner is not installed" in capsys.readouterr().err
