"""Where runner state sleeps between processes: ``~/.boardex/``.

Two things outlive the process now — board profiles (``profiles.json``) and
provider keys (``credentials.json``, written by ``credentials.py``). Both are
plain JSON a human can read, back up, and delete; deleting the directory is the
documented reset, which is only true because nothing here is a database.

DESIGN, deliberately boring:

 1. ONE directory, ``~/.boardex``, overridable with ``BOARDEX_STATE_DIR``
    (tests point it at a tmpdir; a multi-bench host gives each runner its own).
    Created on demand — a runner that never saves anything writes nothing.
 2. EVERY write is atomic: a UNIQUE temp file in the SAME directory, created
    O_EXCL (so an existing path — including a planted symlink — is refused, not
    followed) and O_NOFOLLOW, then ``os.replace``. Same directory because
    ``os.replace`` is only atomic within a filesystem; a crash mid-write
    therefore leaves either the old file whole or the new file whole, never
    half a JSON document. The temp file is created with the final file's mode,
    so a secret is never briefly world-readable.
 3. AN ABSENT FILE AND AN UNREADABLE FILE ARE DIFFERENT ANSWERS. Absent means
    "no state yet" and reads as empty. Anything else — a permission error, a
    symlink where a regular file belongs, an I/O error — means WE DO NOT KNOW
    what the state is, and the difference matters because the next write would
    otherwise persist an empty-looking store over a file that was full. So
    those propagate to the caller, which disables persistence for the session
    rather than guessing (see credentials.configure and ProfileStore.load).
 4. Corrupt JSON is the one exception to 3: it is unambiguously unusable, so it
    is moved aside (``<name>.corrupt-<epoch>``) rather than deleted and the
    runner starts fresh. Whatever was in there is still on disk if it mattered;
    the alternative is a runner that cannot boot until the operator hand-edits
    a file they never chose to write.
 5. WRITES NEVER RAISE. They report a bool, and the caller decides whether a
    failed write is survivable (a key that did not persist) or must be surfaced
    (a key whose REMOVAL did not persist — see credentials.delete_key).

Log lines from this module name PATHS ONLY. A value read out of a state file is
never logged, because one of these files holds API keys.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import stat
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

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

# Absent on Windows, where the kernel has no equivalent flag; the symlink
# defenses below are POSIX-strength and best-effort there, exactly like the
# 0600 mode bits, and the README says so rather than pretending otherwise.
_NO_FOLLOW = getattr(os, "O_NOFOLLOW", 0)


def state_dir() -> Path:
    """The state directory for this runner, expanded but NOT created.

    Read from the environment on every call rather than captured at import:
    a test (or a second runner on the same host) sets ``BOARDEX_STATE_DIR``
    before configuring the stores, and there is no point in the process where
    an earlier read would have been the right one.
    """
    raw = os.environ.get(STATE_DIR_ENV, "").strip() or DEFAULT_STATE_DIR
    return Path(raw).expanduser()


def temp_path_for(path: Path) -> Path:
    """A fresh temp name beside ``path``, unique per write.

    Unique, not ``<name>.tmp-<pid>``: a predictable temp name is a path another
    process can pre-create or pre-symlink between our writes, and O_EXCL then
    turns every subsequent save into a refusal (a denial of service on the
    store) instead of a one-off. Unique + O_EXCL means an attacker has to win a
    race against a name they cannot guess, and losing the race costs one write.

    Its own function so a test can pin the refusal deterministically.
    """
    return path.with_name(f"{path.name}.tmp-{os.getpid()}-{uuid4().hex[:8]}")


def write_json(path: Path, data: Any, *, mode: int = READABLE_FILE) -> bool:
    """Atomically write ``data`` as JSON to ``path``. True when it landed.

    The temp file is created with ``mode`` from the start (``os.open``, not
    open-then-chmod): between those two calls a credentials file would exist at
    the default 0644 with a key already in it, and ``os.replace`` preserves the
    temp file's mode, so creating it right is also what makes the final file
    right. O_EXCL | O_NOFOLLOW means we only ever write a file WE created: an
    existing temp path is refused, and a symlink planted at that name is
    refused rather than followed — the write that would otherwise land, with
    our mode and our contents, in whatever directory the link chose.

    ``os.replace`` onto the destination is deliberately NOT symlink-aware: it
    swaps the LINK for our file and leaves the link's target untouched. The
    guard that matters for the destination is on the READ side, where a
    credentials file that is not a regular file is refused outright and
    persistence is disabled for the session — so a write never reaches a
    destination we have not already vouched for.

    Never raises (rule 5): a state file that cannot be written is logged and
    the caller carries on with what it holds in memory. The temp file is
    removed on failure, so a full disk or a vanished home directory cannot
    litter the directory with half-written state.
    """
    tmp = temp_path_for(path)
    try:
        path.parent.mkdir(mode=OWNER_ONLY_DIR, parents=True, exist_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NO_FOLLOW, mode)
    except OSError as exc:
        # The path and the errno — never the payload.
        logger.warning("could not open a temp file beside %s (%s); not written", path, exc)
        return False
    try:
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
        logger.warning("could not write %s (%s); continuing in memory", path, exc)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return False


def read_json(path: Path, *, default: Any, no_follow: bool = False) -> Any:
    """Parse ``path``; ``default`` for an absent or corrupt file.

    RAISES ``OSError`` for anything else — a permission error, a symlink where
    ``no_follow`` demands a regular file, an I/O error. That is rule 3: an
    unreadable file is not an empty one, and returning ``default`` here would
    hand the caller an empty store that its next write would persist over state
    that is still perfectly good on disk.

    A file whose JSON parses to the wrong SHAPE counts as corrupt, like
    unparseable bytes: a stray ``"hello"`` in profiles.json must not survive
    until something downstream trips over it.

    ``no_follow`` is for the credentials file and closes the read side against
    a symlink swapped in between the check and the open — there is no check,
    only an open that refuses links, and an ``fstat`` on the descriptor we now
    hold rather than a second look at the path.
    """
    try:
        raw = _read_text(path, no_follow=no_follow)
    except FileNotFoundError:
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


def _read_text(path: Path, *, no_follow: bool) -> str:
    if not no_follow:
        return path.read_text(encoding="utf-8")
    # O_NOFOLLOW fails with ELOOP on a symlink, so the refusal happens INSIDE
    # the open — there is no window between deciding and reading. The fstat is
    # on the descriptor we already hold, so what we vet is what we read, even
    # if the path is swapped under us a microsecond later.
    fd = os.open(path, os.O_RDONLY | _NO_FOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise OSError(errno.EINVAL, "not a regular file", str(path))
        handle = os.fdopen(fd, "r", encoding="utf-8")
    except BaseException:
        os.close(fd)
        raise
    with handle:
        return handle.read()


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

    It holds ONLY user-saved profiles. The synthetic fallback profile and any
    launch-config profile come from their own source on every boot, and writing
    them here would fossilize a copy that outlives the launch that produced it.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        # Set False by a load that could not read the file: we do not know what
        # is in there, so we must not write over it (rule 3).
        self.writable = True

    def load(self) -> dict[str, dict[str, Any]]:
        """Persisted profiles, keyed by id. Entries without an ``id`` are
        dropped rather than failing the boot — the runner keys on id, so an
        idless entry could never be addressed anyway.

        An unreadable file costs persistence for the session, not the boot: the
        runner serves the profiles its launch gave it and never writes, so the
        file that could not be read is still exactly as it was when the
        permission problem is fixed.
        """
        try:
            raw = read_json(self.path, default=[])
        except OSError as exc:
            logger.warning(
                "could not read %s (%s); board profiles will not persist this session",
                self.path,
                exc,
            )
            self.writable = False
            return {}
        return {
            str(profile["id"]): profile
            for profile in raw
            if isinstance(profile, dict) and profile.get("id")
        }

    def save(self, profiles: dict[str, dict[str, Any]]) -> bool:
        """Write the user-saved profile set through. Called on every save, so
        the file is never a stale subset of what the user has saved."""
        if not self.writable:
            return False
        return write_json(self.path, list(profiles.values()), mode=READABLE_FILE)
