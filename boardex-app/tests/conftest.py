"""Suite-wide guard: no runner this suite starts may outlive it.

`boardex up` spawns a real `boardex-runner` in the integration tests, and a
server that survives its test holds a port and answers `/health` — which makes
the NEXT run flaky and leaves a stranger's process on a developer's machine.
The CLI stopping its own runner is the real fix (it handles SIGTERM as well as
Ctrl-C, and each UpProcess reaps its process group); this fixture is the
independent check that the fix holds, so a regression fails the suite instead of
accumulating silently.

Only processes that appeared DURING the session count: a developer with their
own `boardex up` running in another terminal must not fail the suite.
"""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest

# Exactly how the CLI spawns it: `<python> -m boardex_runner.server`. Matched as
# a SUFFIX of the command line rather than a substring anywhere, so a shell or an
# editor that merely mentions the module — including the shell running pytest —
# is not counted as a stray server.
RUNNER_CMDLINE_SUFFIX = "-m boardex_runner.server"


def runner_pids() -> set[str]:
    """PIDs of every running `python -m boardex_runner.server`.

    `ps` rather than pgrep: pgrep's useful full-command-line listing (-a) is
    Linux-only, and this has to read the same on macOS. Empty — and therefore
    inert — where `ps` does not exist at all (Windows, where the integration
    tests are skipped anyway).

    ``-ww`` and a wide COLUMNS are load-bearing, not decoration: ps truncates
    the args column to the terminal width, pytest exports COLUMNS, and a venv
    python path is long enough that `-m boardex_runner.server` falls off the
    end. Without them this guard silently sees no processes at all and passes
    while the orphans it exists to catch are running.
    """
    ps = shutil.which("ps")
    if ps is None:
        return set()
    listing = subprocess.run(
        [ps, "-eww", "-o", "pid=,args="],
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "COLUMNS": "10000"},
    )
    pids = set()
    for line in listing.stdout.splitlines():
        pid, _, command = line.strip().partition(" ")
        if pid.isdigit() and command.strip().endswith(RUNNER_CMDLINE_SUFFIX):
            pids.add(pid)
    return pids


@pytest.fixture(scope="session", autouse=True)
def no_runner_outlives_the_suite() -> object:
    before = runner_pids()
    yield
    survivors = runner_pids() - before
    assert not survivors, (
        f"{len(survivors)} boardex-runner process(es) outlived the suite "
        f"(pids {', '.join(sorted(survivors))}) — a `boardex up` test left its "
        "runner behind."
    )
