"""Where runner state sleeps between processes: ``~/.boardex/``.

Two things outlive the process now — board profiles (``profiles.json``) and
provider keys (``credentials.json``, written by ``credentials.py``). Both are
plain JSON a human can read, back up, and delete; deleting the directory is the
documented reset, which is only true because nothing here is a database.

DESIGN, deliberately boring:

 1. ONE directory, ``~/.boardex``, overridable with ``BOARDEX_STATE_DIR``
    (tests point it at a tmpdir; a multi-bench host gives each runner its own).
    Created on demand — a runner that never saves anything writes nothing.
 2. EVERY write is atomic: a temp file in the SAME directory, then
    ``os.replace``. Same directory because ``os.replace`` is only atomic within
    a filesystem; a crash mid-write therefore leaves either the old file whole
    or the new file whole, never half a JSON document. The temp file is created
    with the final file's mode, so a secret is never briefly world-readable.
 3. STATE FILES NEVER CRASH THE RUNNER. Unreadable, unwritable, or garbage —
    the runner boots and serves. A read-only home directory costs you
    persistence, not the ability to run a bench.
 4. Corrupt JSON is moved aside (``<name>.corrupt-<epoch>``) rather than
    deleted, and the runner starts fresh. Whatever was in there is still on
    disk if it mattered; the alternative is a runner that cannot boot until the
    operator hand-edits a file they never chose to write.

Log lines from this module name PATHS ONLY. A value read out of a state file is
never logged, because one of these files holds API keys.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

STATE_DIR_ENV = "BOARDEX_STATE_DIR"
DEFAULT_STATE_DIR = "~/.boardex"

PROFILES_FILE = "profiles.json"
CREDENTIALS_FILE = "credentials.json"

# Owner-only, for the directory and for the credentials file inside it. The
# ~/.netrc / ~/.aws/credentials standard: a local file the owner alone can read.
OWNER_ONLY_DIR = 0o700
OWNER_ONLY_FILE = 0o600
# profiles.json holds a repo path and bench wiring, not secrets — normal mode.
READABLE_FILE = 0o644


def state_dir() -> Path:
    """The state directory for this runner, expanded but NOT created.

    Read from the environment on every call rather than captured at import:
    a test (or a second runner on the same host) sets ``BOARDEX_STATE_DIR``
    before configuring the stores, and there is no point in the process where
    an earlier read would have been the right one.
    """
    raw = os.environ.get(STATE_DIR_ENV, "").strip() or DEFAULT_STATE_DIR
    return Path(raw).expanduser()


def write_json(path: Path, data: Any, *, mode: int = READABLE_FILE) -> bool:
    """Atomically write ``data`` as JSON to ``path``. True when it landed.

    The temp file is created with ``mode`` from the start (``os.open``, not
    open-then-chmod): between those two calls a credentials file would exist at
    the default 0644 with a key already in it, and ``os.replace`` preserves the
    temp file's mode, so creating it right is also what makes the final file
    right.

    Never raises: a state file that cannot be written is logged and the caller
    carries on with what it holds in memory (rule 3 in the module docstring).
    The temp file is removed on failure, so a full disk or a vanished home
    directory cannot litter the directory with half-written state.
    """
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    try:
        path.parent.mkdir(mode=OWNER_ONLY_DIR, parents=True, exist_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            # Indented and newline-terminated: these files are meant to be read
            # and diffed by whoever owns the machine.
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        return True
    except OSError as exc:
        # The path and the errno — never the payload.
        logger.warning("could not write %s (%s); continuing in memory", path, exc)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return False


def read_json(path: Path, *, default: Any) -> Any:
    """Parse ``path``, or return ``default`` — for an absent, unreadable, or
    corrupt file. A file whose JSON parses to the wrong SHAPE counts as corrupt
    too: a stray ``"hello"`` in profiles.json must not survive until something
    downstream trips over it.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return default
    except OSError as exc:
        logger.warning("could not read %s (%s); starting with empty state", path, exc)
        return default
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        _move_aside(path)
        return default
    if not isinstance(parsed, type(default)):
        _move_aside(path)
        return default
    return parsed


def _move_aside(path: Path) -> None:
    """Rename a corrupt state file out of the way, keeping its contents on disk.

    ``rename`` does not follow symlinks: a symlinked state file moves the LINK
    aside and leaves whatever it pointed at untouched.
    """
    aside = path.with_name(f"{path.name}.corrupt-{int(time.time())}")
    suffix = 1
    while aside.exists():
        aside = path.with_name(f"{path.name}.corrupt-{int(time.time())}-{suffix}")
        suffix += 1
    try:
        path.rename(aside)
    except OSError as exc:
        logger.warning("%s is not valid JSON and could not be moved aside (%s)", path, exc)
        return
    # One honest line, naming both paths and nothing that was inside them.
    logger.warning("%s was not valid JSON; moved to %s and starting fresh", path, aside)


class ProfileStore:
    """``profiles.json``: the board profiles the dashboard has saved.

    Shape is a JSON ARRAY of wire ``BoardProfile`` objects — the same shape
    ``BOARDEX_BOARD_PROFILES`` accepts, so the file a user backs up can also be
    baked into a launch, and one runner's saved profiles can be handed to
    another by copying the file.
    """

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> dict[str, dict[str, Any]]:
        """Persisted profiles, keyed by id. Entries without an ``id`` are
        dropped rather than failing the boot — the runner keys on id, so an
        idless entry could never be addressed anyway."""
        raw = read_json(self.path, default=[])
        return {
            str(profile["id"]): profile
            for profile in raw
            if isinstance(profile, dict) and profile.get("id")
        }

    def save(self, profiles: dict[str, dict[str, Any]]) -> None:
        """Write the whole profile set through. Called on every save, so the
        file is never a stale subset of what the runner is serving."""
        write_json(self.path, list(profiles.values()), mode=READABLE_FILE)
