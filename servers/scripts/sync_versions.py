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
PACKAGES = ("boardex-core", "boardex-target", "boardex-logic", "boardex-runner")
_VERSION_LINE = re.compile(r'^version = "(?P<version>[^"]+)"$', re.MULTILINE)
TAG_PREFIX = "servers-v"


def read_version() -> str:
    version = (SERVERS_DIR / "VERSION").read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+([a-z0-9.+-]*)?", version):
        raise SystemExit(f"servers/VERSION holds a malformed version: {version!r}")
    return version


def package_version(pyproject: Path) -> str:
    match = _VERSION_LINE.search(pyproject.read_text(encoding="utf-8"))
    if match is None:
        raise SystemExit(f"{pyproject}: no static `version = \"...\"` line found")
    return match["version"]


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

    for name in PACKAGES:
        pyproject = SERVERS_DIR / name / "pyproject.toml"
        current = package_version(pyproject)
        if current == version:
            continue
        if args.check:
            drift.append(f"{name}: {current} != {version}")
        else:
            text = pyproject.read_text(encoding="utf-8")
            pyproject.write_text(
                _VERSION_LINE.sub(f'version = "{version}"', text, count=1),
                encoding="utf-8",
            )
            print(f"{name}: {current} -> {version}")

    if drift:
        print("version drift:\n  " + "\n  ".join(drift), file=sys.stderr)
        return 1
    print(f"all server packages at {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
