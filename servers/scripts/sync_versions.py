#!/usr/bin/env python3
"""Keep the four server packages on one lockstep version (servers/VERSION).

The packages release together as one set (a boardex-target wheel is only
tested against the boardex-core wheel from the same tag), so a single
``servers/VERSION`` file is the source of truth and each ``pyproject.toml``
carries a synced static ``version = "X.Y.Z"`` line. Static versions keep the
sdists self-contained — no build hook has to reach outside the package dir.

Usage:
    python servers/scripts/sync_versions.py            # rewrite pyprojects
    python servers/scripts/sync_versions.py --check    # exit 1 on drift
    python servers/scripts/sync_versions.py --check --tag servers-v0.1.0
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

SERVERS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVERS_DIR.parent
PACKAGES = ("boardex-core", "boardex-target", "boardex-logic", "boardex-runner")
_VERSION_LINE = re.compile(r'^version = "(?P<version>[^"]+)"$', re.MULTILINE)
TAG_PREFIX = "servers-v"

# The `boardex` launcher (boardex-app/) releases in lockstep with the four
# server packages: its own version, plus the SERVERS_VERSION constant its
# metadata hook uses to pin the four siblings in published artifacts.
APP_PYPROJECT = REPO_ROOT / "boardex-app" / "pyproject.toml"
APP_HATCH_BUILD = REPO_ROOT / "boardex-app" / "hatch_build.py"
_PIN_LINE = re.compile(r'^SERVERS_VERSION = "(?P<version>[^"]+)"$', re.MULTILINE)


def read_version() -> str:
    version = (SERVERS_DIR / "VERSION").read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+([a-z0-9.+-]*)?", version):
        raise SystemExit(f"servers/VERSION holds a malformed version: {version!r}")
    return version


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify, don't rewrite")
    parser.add_argument(
        "--tag", help=f"release tag that must equal {TAG_PREFIX}<VERSION>"
    )
    args = parser.parse_args()

    version = read_version()
    drift: list[str] = []

    if args.tag is not None and args.tag != f"{TAG_PREFIX}{version}":
        drift.append(
            f"tag {args.tag!r} does not match servers/VERSION "
            f"({TAG_PREFIX}{version} expected)"
        )

    targets: list[tuple[str, Path, re.Pattern[str], str]] = [
        (name, SERVERS_DIR / name / "pyproject.toml", _VERSION_LINE, f'version = "{version}"')
        for name in PACKAGES
    ]
    targets.append(("boardex (app)", APP_PYPROJECT, _VERSION_LINE, f'version = "{version}"'))
    targets.append(
        ("boardex (sibling pins)", APP_HATCH_BUILD, _PIN_LINE, f'SERVERS_VERSION = "{version}"')
    )

    for name, path, pattern, replacement in targets:
        match = pattern.search(path.read_text(encoding="utf-8"))
        if match is None:
            raise SystemExit(f"{path}: no version line matching {pattern.pattern!r} found")
        current = match["version"]
        if current == version:
            continue
        if args.check:
            drift.append(f"{name}: {current} != {version}")
        else:
            text = path.read_text(encoding="utf-8")
            path.write_text(pattern.sub(replacement, text, count=1), encoding="utf-8")
            print(f"{name}: {current} -> {version}")

    if drift:
        print("version drift:\n  " + "\n  ".join(drift), file=sys.stderr)
        return 1
    print(f"all server packages (and the boardex launcher) at {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
