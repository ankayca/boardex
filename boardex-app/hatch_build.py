"""Build-time hooks for the `boardex` distribution.

Two custom hooks, because both jobs are monorepo-specific:

**MetadataHook — where the four server packages come from.**
`boardex` is a thin launcher over `boardex-core/-logic/-target/-runner`. By
default the four resolve to `==SERVERS_VERSION` pins — the only requirement that
means anything on a machine that does not have this repo, and therefore the only
one a published sdist or wheel may carry. `BOARDEX_LOCAL_SIBLINGS=1` opts into
local path requirements against the sibling `servers/` tree instead: that is the
from-source install (`pip install ./boardex-app`, or the
`git+ssh://…#subdirectory=boardex-app` form, where pip clones the WHOLE repo and
builds this subdirectory), which is what works TODAY, since none of the four is
on an index yet.

The default is the publishable one on purpose. Metadata leaks: a `file://`
requirement baked into an sdist's PKG-INFO reappears in every wheel built from
that sdist — hatchling reads the sdist's static metadata rather than re-running
this hook — so `python -m build` produced two artifacts that only installed on
the machine that built them, and nothing about either announced it. Pinning by
default means the accident is now the opt-in. See README-quickstart.md
§ "Where the dependencies come from".

**BuildHook — what makes the wheel self-contained.**
It builds the UI (`npm ci` at the repo root first when the clone has no
`node_modules` yet, then `npm run build -w apps/ui` with `VITE_RUNNER_URL=""` so
the bundle talks to whatever origin serves it) and copies three things into
`boardex_app/_bundled/`:

* `ui/` — the built UI, so the installed machine needs no Node;
* `contract-schema/` — a verbatim copy of `packages/contract/json-schema/`. The
  runner validates every outbound event against it and finds it by walking up
  for a repo checkout, which an installed wheel does not sit in; `boardex up`
  points the runner at this copy via the runner's own
  `BOARDEX_CONTRACT_SCHEMA_DIR` seam. It is a copy of a generated cross-language
  bridge (BIBLE §3), never an edit of it;
* `udev/` — the probe udev rules, so `boardex doctor` can print a paste-ready
  install line that references a file the user actually has.

`BOARDEX_SKIP_UI_BUILD=1` reuses an existing `apps/ui/dist` instead of running
npm (CI, and repeated local installs).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

try:  # pragma: no cover - present whenever hatchling is actually building
    from hatchling.builders.hooks.plugin.interface import BuildHookInterface
    from hatchling.metadata.plugin.interface import MetadataHookInterface
except ImportError:  # the pure helpers below are unit-tested without hatchling
    BuildHookInterface = object  # type: ignore[assignment,misc]
    MetadataHookInterface = object  # type: ignore[assignment,misc]

# Lockstep with servers/VERSION — the four server packages version together.
SERVERS_VERSION = "0.1.0"

# Opt in to local path requirements for the four siblings (from-source installs).
LOCAL_SIBLINGS_ENV = "BOARDEX_LOCAL_SIBLINGS"

# (distribution name, path under the repo root, extras). The runner carries
# [agent] because `boardex up` defaults to BENCH=agent.
SIBLINGS = (
    ("boardex-core", "servers/boardex-core", ""),
    ("boardex-logic", "servers/boardex-logic", ""),
    ("boardex-target", "servers/boardex-target", ""),
    ("boardex-runner", "servers/boardex-runner", "[agent]"),
)

UI_WORKSPACE = "apps/ui"
UI_DIST = "apps/ui/dist"
NODE_MODULES = "node_modules"
LOCKFILE = "package-lock.json"
CONTRACT_SCHEMA = "packages/contract/json-schema"
UDEV_RULES = "servers/boardex-target/contrib/udev/49-boardex-probes.rules"
BUNDLE_DIR = "boardex_app/_bundled"


def sibling_dependencies(repo_root: Path, *, local: bool = False) -> list[str]:
    """The four server requirements: version pins, or local paths when asked.

    Pins are the default because they are the only form that survives leaving
    this machine. Local paths are returned only when ``local`` is set AND all
    four siblings are actually there — all four or none, since a half-local,
    half-pinned set would resolve two different versions of one lockstep set.
    """
    present = all((repo_root / relative / "pyproject.toml").is_file() for _, relative, _ in SIBLINGS)
    if not (local and present):
        return [f"{name}{extras}=={SERVERS_VERSION}" for name, _, extras in SIBLINGS]
    return [
        f"{name}{extras} @ {(repo_root / relative).resolve().as_uri()}"
        for name, relative, extras in SIBLINGS
    ]


# What to tell someone whose machine cannot build from source. The wheel is
# built elsewhere and carries the UI already compiled, so it needs no Node at
# all — see README-quickstart.md § "Install".
WHEEL_INSTALL_HINT = "pipx install ./boardex-*-py3-none-any.whl"
NO_NPM_MESSAGE = (
    "npm is not on PATH: building from source requires Node 20+ — or install "
    f"the prebuilt wheel instead ({WHEEL_INSTALL_HINT}), which ships the UI "
    "already built. (Inside a checkout that already has apps/ui/dist, "
    "BOARDEX_SKIP_UI_BUILD=1 reuses it.)"
)


def install_node_modules(repo_root: Path, npm: str, run: object = subprocess.run) -> None:
    """Install the workspace's npm dependencies, if the clone has none.

    `pip install "git+…#subdirectory=boardex-app"` clones the WHOLE repo into a
    temp dir and builds here — a clone with no `node_modules`, where
    `npm run build -w apps/ui` exits 127 with "vite: not found". This step is
    the difference between that and a working from-source install; it was
    invisible for as long as every build happened in a checkout that had been
    `npm install`-ed by hand.

    Skipped when `node_modules` is already there: `npm ci` deletes and reinstalls
    the tree, and a developer running `pip install -e ./boardex-app` should not
    pay for that (or lose a local link) on every install.
    """
    if (repo_root / NODE_MODULES).is_dir():
        return
    # `npm ci` is the reproducible one, but it REQUIRES a lockfile — an sdist or
    # a partial tree without one gets the resolving install rather than a hard error.
    command = "ci" if (repo_root / LOCKFILE).is_file() else "install"
    run(  # type: ignore[operator]
        [npm, command],
        cwd=str(repo_root),
        check=True,
    )


def build_ui(repo_root: Path, run: object = subprocess.run) -> None:
    """`npm run build -w apps/ui` against the same origin that will serve it.

    VITE_RUNNER_URL="" makes the bundle's runner base relative, so the UI talks
    to whatever host:port serves it — which is the runner itself.
    """
    npm = shutil.which("npm")
    if npm is None:
        raise RuntimeError(NO_NPM_MESSAGE)
    install_node_modules(repo_root, npm, run)
    env = {**os.environ, "VITE_RUNNER_URL": ""}
    run(  # type: ignore[operator]
        [npm, "run", "build", "-w", UI_WORKSPACE],
        cwd=str(repo_root),
        env=env,
        check=True,
    )


def _replace_tree(source: Path, target: Path) -> None:
    """Copy source over target, replacing it — a stale hashed asset never lingers."""
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)


def bundle_assets(repo_root: Path, project_root: Path, *, skip_ui_build: bool = False) -> Path:
    """Populate boardex_app/_bundled/ (UI, contract schemas, udev rules)."""
    bundle = project_root / BUNDLE_DIR
    dist = repo_root / UI_DIST

    if not skip_ui_build:
        build_ui(repo_root)
    if not (dist / "index.html").is_file():
        raise RuntimeError(
            f"no built UI at {dist} — run `npm run build -w {UI_WORKSPACE}` "
            "(or unset BOARDEX_SKIP_UI_BUILD so this build runs it)."
        )
    _replace_tree(dist, bundle / "ui")

    schemas = repo_root / CONTRACT_SCHEMA
    if not (schemas / "events.schema.json").is_file():
        raise RuntimeError(
            f"no emitted contract schemas at {schemas} — the runner validates "
            "every outbound event against them, so the wheel cannot ship without."
        )
    _replace_tree(schemas, bundle / "contract-schema")

    rules = repo_root / UDEV_RULES
    if rules.is_file():
        udev_target = bundle / "udev"
        udev_target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(rules, udev_target / rules.name)
    return bundle


def missing_bundle_parts(bundle: Path) -> list[str]:
    """Which required halves of the bundle are absent (empty = complete).

    Both are load-bearing at runtime: without ``ui`` the wheel serves no app,
    and without ``contract-schema`` the runner cannot emit a single event (it
    validates first, and an installed wheel has no checkout to walk up into).
    """
    return [
        name
        for name, probe in (
            ("ui", "ui/index.html"),
            ("contract-schema", "contract-schema/events.schema.json"),
        )
        if not (bundle / probe).is_file()
    ]


def prepare_bundle(repo_root: Path, project_root: Path, *, skip_ui_build: bool = False) -> Path:
    """Everything BuildHook.initialize does — one path, one verification.

    Inside the monorepo the bundle is (re)built from source. Outside it — an
    sdist build, where the bundle travelled in the archive and nothing here
    could regenerate it — it is taken as found. EITHER WAY the result is then
    verified, because a wheel missing either half is broken in a way that only
    shows up on the user's machine, and "the build fails loudly" has to mean
    every route to a wheel, not just the one that does the copying.
    """
    bundle = project_root / BUNDLE_DIR
    if (repo_root / UI_WORKSPACE / "package.json").is_file():
        bundle_assets(repo_root, project_root, skip_ui_build=skip_ui_build)
    missing = missing_bundle_parts(bundle)
    if missing:
        raise RuntimeError(
            f"incomplete bundle at {bundle} — missing {', '.join(missing)}. "
            "Build from the monorepo (this hook then builds the UI and copies "
            "the emitted contract schemas), or install an sdist that already "
            "carries them."
        )
    return bundle


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


class MetadataHook(MetadataHookInterface):  # type: ignore[misc]
    PLUGIN_NAME = "custom"

    def update(self, metadata: dict) -> None:
        metadata["dependencies"] = sibling_dependencies(
            Path(self.root).parent,
            local=_truthy(os.environ.get(LOCAL_SIBLINGS_ENV)),
        )


class BuildHook(BuildHookInterface):  # type: ignore[misc]
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        project_root = Path(self.root)
        prepare_bundle(
            project_root.parent,
            project_root,
            skip_ui_build=_truthy(os.environ.get("BOARDEX_SKIP_UI_BUILD")),
        )
