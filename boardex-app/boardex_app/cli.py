"""``boardex`` — the one command a new user runs.

``boardex up`` launches ``boardex-runner`` in a child process with the embedded
UI bundle wired in (``BOARDEX_SERVE_UI``), waits for ``/health``, prints the URL
and opens a browser. Single origin: the bundled UI is built with an empty
``VITE_RUNNER_URL``, so it talks to whatever host:port served it — no ports to
reconcile, no CORS.

``boardex up --demo`` is the same launch pointed at ``/demo``, the UI's
client-side replay of a recorded agent run: no hardware, no API key, no runner
interaction at all (see README-quickstart.md for why that path was chosen). Its
runner runs the fake bench, so stepping out of the demo into the live app lands
somewhere that works rather than on an agent bench with no key.

A first run needs a model provider key, and no shell is needed for it: the
runner holds a write-only credential store, so the key goes in at Settings →
Model provider in the browser. An exported provider variable still works and
boots the runner already configured — ``boardex up`` says which of the two it
found (nothing is stored anywhere by this CLI; it only reports).

``boardex doctor`` reports what the machine is missing, with the fix per item.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any

from . import __version__
from . import doctor as doctor_module
from .ui_assets import contract_schema_dir, ui_bundle_dir

# The real runner's own default (boardex_runner.server.DEFAULT_PORT). Read as a
# constant rather than imported so `boardex --version` and `boardex doctor` work
# even in an install whose runner is broken.
DEFAULT_PORT = 4380
DEFAULT_HOST = "127.0.0.1"
# BENCH=agent imports litellm at startup, which is slow on a cold filesystem.
HEALTH_TIMEOUT_S = 120.0
HEALTH_POLL_S = 0.25
# How long the runner gets to shut down gracefully before it is killed.
STOP_GRACE_S = 10.0


# -- helpers ---------------------------------------------------------------------------


def browse_host(host: str) -> str:
    """A host a browser can actually open (0.0.0.0/:: are bind addresses)."""
    return {"0.0.0.0": "127.0.0.1", "::": "[::1]", "": "127.0.0.1"}.get(host, host)


def port_available(host: str, port: int) -> bool:
    """Can the runner bind here? Asked BEFORE spawning it.

    Without this, an occupied port produces the runner's own bind traceback
    followed by our health-timeout message — two failures for one cause, neither
    of which says "something is already listening". Worse, if the occupant is a
    previous `boardex up`, /health answers and the banner would announce a
    server this process does not own and cannot stop.

    SO_REUSEADDR matches what aiohttp's TCPSite does, so this asks the question
    the runner will ask: it succeeds over a TIME_WAIT socket and fails against a
    live listener. A probe that cannot run at all (an exotic host string) is
    never treated as "occupied" — the launch proceeds and the runner speaks for
    itself.
    """
    try:
        infos = socket.getaddrinfo(host or "127.0.0.1", port, type=socket.SOCK_STREAM)
    except OSError:
        return True
    for family, socktype, proto, _canon, address in infos:
        try:
            with socket.socket(family, socktype, proto) as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(address)
        except OSError:
            return False
        except Exception:  # pragma: no cover - defensive: never block a launch
            return True
    return True


def probe_health(url: str, timeout: float = 1.0) -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(f"{url}/health", timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return None
    return body if isinstance(body, dict) else None


def wait_for_health(
    url: str,
    process: "subprocess.Popen[bytes] | None" = None,
    timeout: float = HEALTH_TIMEOUT_S,
    sleep: Any = time.sleep,
) -> dict[str, Any] | None:
    """Poll /health until the runner answers, it dies, or the deadline passes."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            return None  # the runner exited; its own output already said why
        health = probe_health(url)
        if health is not None:
            return health
        sleep(HEALTH_POLL_S)
    return None


def stop_process(process: "subprocess.Popen[bytes]", grace: float = STOP_GRACE_S) -> int:
    """Ask the runner to stop, then insist. Returns its exit code.

    aiohttp's ``run_app`` turns SIGTERM into a graceful shutdown, so terminate()
    is the polite ask; a runner wedged past the grace window is killed, because
    a `boardex up` that will not exit is worse than an ungraceful stop.
    """
    if process.poll() is not None:
        return process.returncode
    process.terminate()
    try:
        return process.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        process.kill()
        return process.wait(timeout=grace)


def runner_missing() -> bool:
    return importlib.util.find_spec("boardex_runner") is None


# Sentinel: signal.signal returns SIG_DFL (0) for "no handler was installed",
# which is falsey but very much a value to restore.
_NO_PREVIOUS_HANDLER = object()


def _stop_like_ctrl_c(_signum: int, _frame: Any) -> None:
    """Route SIGTERM into the KeyboardInterrupt path — one way down, not two.

    Whoever stops `boardex up` is usually not a terminal: a supervisor, a
    container stop, a test harness, `kill`. Without this the CLI dies where it
    stands and the runner it spawned is reparented and keeps holding the port —
    an invisible server nobody asked for.
    """
    raise KeyboardInterrupt


def _install_sigterm_handler() -> Any:
    """Install the handler, returning what to put back (or the sentinel).

    Signals can only be installed from the main thread; a caller running
    command_up off-thread (a harness, an embedding) gets the old behavior rather
    than an exception, which is why the failure is swallowed rather than raised.
    """
    try:
        return signal.signal(signal.SIGTERM, _stop_like_ctrl_c)
    except (ValueError, OSError, AttributeError):  # pragma: no cover - platform/thread
        return _NO_PREVIOUS_HANDLER


def _restore_sigterm_handler(previous: Any) -> None:
    """Leave the process's signal disposition exactly as it was found."""
    if previous is _NO_PREVIOUS_HANDLER:
        return
    try:
        signal.signal(signal.SIGTERM, previous)
    except (ValueError, OSError, AttributeError):  # pragma: no cover - platform/thread
        pass


# -- boardex up ------------------------------------------------------------------------


def runner_env(
    *,
    host: str,
    port: int,
    bench: str,
    ui_root: Path | None,
    schema_dir: Path | None = None,
    base_env: dict[str, str] | None = None,
) -> dict[str, str]:
    """The child runner's environment (see boardex_runner.server.state_from_env).

    Everything else the runner reads — AGENT_MODELS, BOARDEX_BOARD_PROFILES,
    provider keys — passes through from the caller's environment untouched.
    """
    env = dict(os.environ if base_env is None else base_env)
    env["HOST"] = host
    env["PORT"] = str(port)
    env["BENCH"] = bench
    if ui_root is not None:
        env["BOARDEX_SERVE_UI"] = str(ui_root)
    # The runner finds the contract schemas by walking up for a checkout, which
    # an installed wheel never sits in; hand it the bundled copy. An override
    # already in the environment wins (a developer pointing at their own tree).
    if schema_dir is not None and not env.get("BOARDEX_CONTRACT_SCHEMA_DIR", "").strip():
        env["BOARDEX_CONTRACT_SCHEMA_DIR"] = str(schema_dir)
    return env


def resolve_bench(bench: str | None, demo: bool) -> str:
    """`up` runs the agent bench; `up --demo` runs the fake one.

    The demo tour itself is client-side, so the bench behind it only matters for
    what happens when the user leaves the demo: the fake bench needs no hardware
    and no key, so the live app they land in still works.
    """
    if bench is not None:
        return bench
    return "fake" if demo else "agent"


def command_up(args: argparse.Namespace) -> int:
    if runner_missing():
        print(
            "boardex: boardex-runner is not installed in this environment.\n"
            "  fix: pip install --force-reinstall boardex",
            file=sys.stderr,
        )
        return 1

    # A BOARDEX_SERVE_UI already in the environment wins: that is a developer
    # pointing at their own build, and silently overriding it would be a lie.
    preset_ui = os.environ.get("BOARDEX_SERVE_UI", "").strip()
    ui_root = Path(preset_ui) if preset_ui else ui_bundle_dir()
    if ui_root is None:
        print(
            "boardex: this install carries no UI bundle — starting the API only.\n"
            "  fix: pip install --force-reinstall boardex",
            file=sys.stderr,
        )

    if not port_available(args.host, args.port):
        print(
            f"boardex: port {args.port} is in use — is another boardex/runner "
            "already running?\n"
            "  fix: stop it, or `boardex up --port <other>`",
            file=sys.stderr,
        )
        return 1

    bench = resolve_bench(args.bench, args.demo)
    url = f"http://{browse_host(args.host)}:{args.port}"
    target = f"{url}/demo" if args.demo else url

    env = runner_env(
        host=args.host,
        port=args.port,
        bench=bench,
        ui_root=ui_root,
        schema_dir=contract_schema_dir(),
    )
    process = subprocess.Popen([sys.executable, "-m", "boardex_runner.server"], env=env)

    previous_term = _install_sigterm_handler()
    try:
        health = wait_for_health(url, process)
        if health is None:
            if process.poll() is None:
                print(
                    f"boardex: the runner did not answer {url}/health within "
                    f"{HEALTH_TIMEOUT_S:.0f}s — stopping it.",
                    file=sys.stderr,
                )
                return stop_process(process) or 1
            return process.returncode or 1

        # Flushed: `boardex up` is commonly piped or run under a supervisor,
        # where a buffered banner would appear only after the process exits.
        print(flush=True)
        print(f"  Boardex {__version__} is up:  {target}")
        print(f"    runner   {health.get('runnerKind', 'real')} · bench {bench} · {url}")
        print(f"    UI       {'embedded' if ui_root else 'not bundled (API only)'}")
        if bench == "agent" and not doctor_module.check_provider_key().ok:
            # No key at boot. The runner holds a credential store, so the fix is
            # in the page that just opened — say that first; the environment is
            # the fallback, not the instruction.
            print(
                "    note     no provider key yet — set one at Settings → Model "
                "provider\n"
                "             in the page above (or export a key before launch). "
                "The UI and\n"
                "             the demo need none."
            )
        print("    Ctrl-C to stop.")
        print(flush=True)

        if not args.no_open:
            try:
                webbrowser.open(target)
            except Exception:  # a headless box has no browser; never fatal
                pass

        return process.wait()
    except KeyboardInterrupt:
        # Ctrl-C, or the SIGTERM the handler above turns into one.
        print("\nboardex: stopping the runner…")
        return stop_process(process)
    finally:
        stop_process(process)
        _restore_sigterm_handler(previous_term)


# -- boardex doctor --------------------------------------------------------------------


def command_doctor(_args: argparse.Namespace) -> int:
    return doctor_module.main()


# -- entry point -----------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="boardex",
        description="Boardex: agentic hardware bring-up on your bench.",
    )
    parser.add_argument("--version", action="version", version=f"boardex {__version__}")
    subparsers = parser.add_subparsers(dest="command")

    up = subparsers.add_parser("up", help="start the runner with the UI and open it")
    up.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"default {DEFAULT_PORT}")
    up.add_argument("--host", default=DEFAULT_HOST, help=f"default {DEFAULT_HOST}")
    up.add_argument(
        "--demo",
        action="store_true",
        help="open the bundled recorded run (/demo) — no hardware, no API key",
    )
    up.add_argument(
        "--bench",
        choices=("agent", "fake", "real"),
        default=None,
        help="runner bench (default: agent; fake with --demo)",
    )
    up.add_argument("--no-open", action="store_true", help="do not open a browser")
    up.set_defaults(handler=command_up)

    check = subparsers.add_parser("doctor", help="check this machine's bench tooling")
    check.set_defaults(handler=command_doctor)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handler = getattr(args, "handler", None)
    if handler is None:
        parser.print_help()
        return 0
    return handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
