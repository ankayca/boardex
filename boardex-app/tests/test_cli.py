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
    is_wsl,
    main,
    muted_stderr,
    open_in_browser,
    port_available,
    probe_health,
    resolve_bench,
    runner_env,
    stop_process,
    wait_for_health,
    wsl_open,
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


def stub_launch(
    monkeypatch: pytest.MonkeyPatch, *, health: dict | None = None, opens: bool = True
) -> list[str]:
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
    # Stubbed at open_in_browser, not at webbrowser: on WSL the real one would
    # reach past webbrowser to cmd.exe and pop a window mid-suite.
    monkeypatch.setattr(
        "boardex_app.cli.open_in_browser", lambda url: opened.append(url) or opens
    )
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


# -- opening a browser -------------------------------------------------------------------


class Completed:
    def __init__(self, returncode: int) -> None:
        self.returncode = returncode


def test_a_browser_that_never_opens_leaves_the_url_and_a_clean_exit(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """WSL's actual first-run experience: nothing opens.

    `webbrowser.open` hands off to `gio open`, which answers "Operation not
    supported" — so the launch must not read as a failure. The URL is already
    printed; the fallback line says it is the user's to open, and `boardex up`
    still exits on its own terms.
    """
    port = free_port()
    opened = stub_launch(monkeypatch, opens=False)

    assert main(["up", "--bench", "fake", "--port", str(port)]) == 0
    captured = capsys.readouterr()
    assert opened == [f"http://127.0.0.1:{port}"], "the open was still attempted"
    assert f"open this in your browser:  http://127.0.0.1:{port}" in captured.out
    assert "Ctrl-C to stop." in captured.out, "the banner still finishes"
    assert captured.err == "", "a browser that will not open is not an error"

    # And when one does open, the line is not printed at all.
    stub_launch(monkeypatch, opens=True)
    assert main(["up", "--bench", "fake", "--port", str(port)]) == 0
    assert "open this in your browser" not in capsys.readouterr().out


def test_muted_stderr_swallows_a_child_processs_noise(capfd: pytest.CaptureFixture[str]) -> None:
    """The noise is written by a CHILD to fd 2, so only the fd can silence it.

    capfd captures at the descriptor level — the same level `gio` writes at —
    which is exactly why this is asserted with capfd and not capsys.
    """
    with muted_stderr():
        subprocess.run(
            [sys.executable, "-c", "import sys; sys.stderr.write('gio: Operation not supported\\n')"],
            check=True,
        )
    os.write(2, b"after the block\n")
    captured = capfd.readouterr()
    assert "Operation not supported" not in captured.err
    assert "after the block" in captured.err, "fd 2 must be restored, not lost"


def test_wsl_is_detected_from_the_kernel_string(tmp_path: Path) -> None:
    named = tmp_path / "version-wsl"
    named.write_text(
        "Linux version 6.6.87.2-microsoft-standard-WSL2 (gcc ...)", encoding="utf-8"
    )
    assert is_wsl(named) is True

    plain = tmp_path / "version-linux"
    plain.write_text("Linux version 6.8.0-41-generic (gcc ...)", encoding="utf-8")
    assert is_wsl(plain) is False

    # No /proc/version at all (macOS, Windows) is simply not WSL.
    assert is_wsl(tmp_path / "absent") is False


def test_wsl_open_crosses_to_windows_and_reports_whether_it_landed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []

    def only(*names: str):  # noqa: ANN202 - which openers this machine "has"
        return lambda name: f"/usr/bin/{name}" if name in names else None

    def run(cmd, **kwargs):  # noqa: ANN001, ANN202
        calls.append(cmd)
        assert kwargs["stderr"] == subprocess.DEVNULL, "cmd.exe's UNC warning is noise"
        assert kwargs["check"] is False, "a failed open is a return value, not a raise"
        return Completed(0)

    monkeypatch.setattr("boardex_app.cli.shutil.which", only("wslview", "cmd.exe"))
    assert wsl_open("http://127.0.0.1:4380/demo", run=run) is True
    assert calls == [["/usr/bin/wslview", "http://127.0.0.1:4380/demo"]]

    # Without wslu, cmd.exe carries it — with the empty title argument, or
    # `start` would swallow the URL as the window title.
    calls.clear()
    monkeypatch.setattr("boardex_app.cli.shutil.which", only("cmd.exe"))
    assert wsl_open("http://127.0.0.1:4380", run=run) is True
    assert calls == [["/usr/bin/cmd.exe", "/c", "start", "", "http://127.0.0.1:4380"]]

    # Neither present: nothing is run and nothing is claimed.
    calls.clear()
    monkeypatch.setattr("boardex_app.cli.shutil.which", only())
    assert wsl_open("http://127.0.0.1:4380", run=run) is False
    assert calls == []


def test_wsl_open_survives_an_opener_that_fails_or_hangs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("boardex_app.cli.shutil.which", lambda name: f"/usr/bin/{name}")

    def wslview_hangs_then_cmd_works(cmd, **kwargs):  # noqa: ANN001, ANN202
        if "wslview" in cmd[0]:
            raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])
        return Completed(0)

    assert wsl_open("http://127.0.0.1:4380", run=wslview_hangs_then_cmd_works) is True
    # Every opener failing is reported honestly rather than raising.
    assert wsl_open("http://127.0.0.1:4380", run=lambda cmd, **k: Completed(1)) is False


def test_open_in_browser_prefers_the_wsl_path_and_falls_back_to_webbrowser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("boardex_app.cli.is_wsl", lambda: True)
    monkeypatch.setattr("boardex_app.cli.wsl_open", lambda url: True)
    monkeypatch.setattr(
        "boardex_app.cli.webbrowser.open",
        lambda url: pytest.fail("the Linux opener was tried on WSL anyway"),
    )
    assert open_in_browser("http://127.0.0.1:4380") is True

    # WSL with no Windows opener still tries the normal path before giving up.
    monkeypatch.setattr("boardex_app.cli.wsl_open", lambda url: False)
    monkeypatch.setattr("boardex_app.cli.webbrowser.open", lambda url: True)
    assert open_in_browser("http://127.0.0.1:4380") is True

    # webbrowser reports failure two ways; neither may escape.
    monkeypatch.setattr("boardex_app.cli.webbrowser.open", lambda url: False)
    assert open_in_browser("http://127.0.0.1:4380") is False

    def explode(url: str) -> bool:
        raise RuntimeError("no browser here")

    monkeypatch.setattr("boardex_app.cli.webbrowser.open", explode)
    assert open_in_browser("http://127.0.0.1:4380") is False


def test_up_refuses_cleanly_when_the_runner_is_not_installed(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("boardex_app.cli.runner_missing", lambda: True)
    assert main(["up", "--no-open"]) == 1
    assert "boardex-runner is not installed" in capsys.readouterr().err
