"""The build hooks: dependency resolution and what lands in the wheel."""

from __future__ import annotations

import shutil
import sys
import tarfile
from pathlib import Path

import hatchling.build
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hatch_build  # noqa: E402
from boardex_app import ui_assets  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]


def make_monorepo(tmp_path: Path) -> Path:
    for _, relative, _ in hatch_build.SIBLINGS:
        package = tmp_path / relative
        package.mkdir(parents=True)
        (package / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    return tmp_path


PINS = [
    "boardex-core==0.1.0",
    "boardex-logic==0.1.0",
    "boardex-target==0.1.0",
    "boardex-runner[agent]==0.1.0",
]


def test_siblings_are_pinned_by_default_even_inside_a_checkout(tmp_path: Path) -> None:
    """The default is the one that survives leaving this machine.

    A checkout used to be enough to switch the four to `file://` paths, which is
    how a plain `python -m build` produced artifacts that installed nowhere else.
    """
    assert hatch_build.sibling_dependencies(make_monorepo(tmp_path)) == PINS


def test_siblings_resolve_to_local_paths_when_asked_inside_a_checkout(tmp_path: Path) -> None:
    deps = hatch_build.sibling_dependencies(make_monorepo(tmp_path), local=True)
    assert len(deps) == 4
    for dep in deps:
        assert " @ file://" in dep
    # The runner carries [agent] — `boardex up` defaults to BENCH=agent.
    assert any(dep.startswith("boardex-runner[agent] @ file://") for dep in deps)
    assert (tmp_path / "servers/boardex-core").resolve().as_uri() in deps[0]


def test_siblings_fall_back_to_version_pins_without_a_checkout(tmp_path: Path) -> None:
    assert hatch_build.sibling_dependencies(tmp_path, local=True) == PINS


def test_a_partial_checkout_is_not_treated_as_a_checkout(tmp_path: Path) -> None:
    """All four or none: half local paths and half pins would resolve two
    different versions of the same lockstep set."""
    root = make_monorepo(tmp_path)
    (root / "servers/boardex-logic/pyproject.toml").unlink()
    assert all(
        "file://" not in dep for dep in hatch_build.sibling_dependencies(root, local=True)
    )


def test_the_pinned_version_tracks_servers_version() -> None:
    """The four server packages version in lockstep via servers/VERSION."""
    recorded = (REPO_ROOT / "servers" / "VERSION").read_text(encoding="utf-8").strip()
    assert hatch_build.SERVERS_VERSION == recorded


# --- What the published metadata says --------------------------------------
#
# The property: a distribution built from this repo installs on a machine that
# has never seen this repo. That reduces to one readable line — the four
# `boardex-*` requirements are `==` pins, and nothing in the metadata headers
# points at a path, because a `file://` requirement names a directory the
# installing machine does not have.


def header_block(metadata: str) -> str:
    """The RFC 822 headers of a METADATA/PKG-INFO document.

    Everything past the first blank line is the long description — this
    project's README, which is prose ABOUT packaging and may legitimately write
    `file://`. Requirements live in the headers, so the headers are what the
    path-freedom assertions read.
    """
    return metadata.split("\n\n", 1)[0]


def requires_dist(metadata: str) -> list[str]:
    """The unconditional Requires-Dist entries (the `dev` extra is not shipped state)."""
    return [
        line.partition(":")[2].strip()
        for line in header_block(metadata).splitlines()
        if line.startswith("Requires-Dist:") and "extra ==" not in line
    ]


def servers_version() -> str:
    return (REPO_ROOT / "servers" / "VERSION").read_text(encoding="utf-8").strip()


def wheel_metadata(project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    """The METADATA hatchling really writes, via the real PEP 517 hook.

    `prepare_metadata_for_build_wheel` runs the metadata hook and nothing else —
    the same text the wheel carries, without building the UI bundle to get it.
    """
    out = tmp_path / "metadata"
    out.mkdir(exist_ok=True)
    monkeypatch.chdir(project)
    return (out / hatchling.build.prepare_metadata_for_build_wheel(str(out)) / "METADATA").read_text(
        encoding="utf-8"
    )


def test_this_projects_built_metadata_pins_the_four_and_names_no_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Rendered from THIS checkout — where the siblings are present and the leak was."""
    monkeypatch.delenv(hatch_build.LOCAL_SIBLINGS_ENV, raising=False)
    metadata = wheel_metadata(REPO_ROOT / "boardex-app", tmp_path, monkeypatch)

    version = servers_version()
    assert requires_dist(metadata) == [
        f"boardex-core=={version}",
        f"boardex-logic=={version}",
        f"boardex-runner[agent]=={version}",
        f"boardex-target=={version}",
    ], "the published pins must be the four server names at servers/VERSION"
    assert "file://" not in header_block(metadata)
    assert " @ " not in header_block(metadata), "no direct reference of any scheme"


def test_the_local_path_form_still_exists_and_takes_asking_for(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The from-source install (BOARDEX_LOCAL_SIBLINGS=1) reaches real metadata.

    Its `file://` requirements are exactly what must never be the default; that
    they still work is what keeps `pip install ./boardex-app` possible while the
    four servers are on no index.
    """
    monkeypatch.setenv(hatch_build.LOCAL_SIBLINGS_ENV, "1")
    deps = requires_dist(wheel_metadata(REPO_ROOT / "boardex-app", tmp_path, monkeypatch))

    assert len(deps) == 4
    for dep in deps:
        assert " @ file://" in dep
    assert any((REPO_ROOT / "servers/boardex-core").as_uri() in dep for dep in deps)


def make_distributable_project(tmp_path: Path) -> Path:
    """This project's real pyproject + hook, with a stub package and bundle.

    A stand-in, so the build under test is a few milliseconds instead of an `npm
    ci` — but the parts that decide the metadata are the shipped files
    themselves, and it sits inside a fake monorepo, since siblings-present is
    the configuration that used to leak.
    """
    repo = make_monorepo(tmp_path)
    project = repo / "boardex-app"
    (project / "boardex_app").mkdir(parents=True)
    (project / "boardex_app" / "__init__.py").write_text("", encoding="utf-8")
    bundle = project / hatch_build.BUNDLE_DIR
    (bundle / "ui").mkdir(parents=True)
    (bundle / "ui" / "index.html").write_text("<html></html>", encoding="utf-8")
    (bundle / "contract-schema").mkdir(parents=True)
    (bundle / "contract-schema" / "events.schema.json").write_text("{}", encoding="utf-8")
    for shipped in ("pyproject.toml", "hatch_build.py", "README.md"):
        shutil.copy2(REPO_ROOT / "boardex-app" / shipped, project / shipped)
    return project


def sdist_pkg_info(project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    out = tmp_path / "dist"
    out.mkdir(exist_ok=True)
    monkeypatch.chdir(project)
    archive_path = out / hatchling.build.build_sdist(str(out))
    with tarfile.open(archive_path) as archive:
        member = next(name for name in archive.getnames() if name.endswith("/PKG-INFO"))
        return archive.extractfile(member).read().decode("utf-8")  # type: ignore[union-attr]


def test_a_built_sdist_carries_pins_not_the_paths_of_the_machine_that_built_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The regression this exists to prevent, at the place it does the most damage.

    An sdist's PKG-INFO is not advisory: hatchling reads that static metadata
    instead of re-running the hook, so a `file://` requirement recorded here
    reappears in every wheel built from the sdist — which is how `python -m
    build` from a clean clone produced a matching PAIR of artifacts that
    installed only on the machine that built them.
    """
    monkeypatch.delenv(hatch_build.LOCAL_SIBLINGS_ENV, raising=False)
    pkg_info = sdist_pkg_info(make_distributable_project(tmp_path), tmp_path, monkeypatch)

    version = servers_version()
    assert requires_dist(pkg_info) == [
        f"boardex-core=={version}",
        f"boardex-logic=={version}",
        f"boardex-runner[agent]=={version}",
        f"boardex-target=={version}",
    ]
    assert "file://" not in header_block(pkg_info)
    assert str(tmp_path) not in pkg_info, "no path of the build machine, anywhere in PKG-INFO"


def record_npm(monkeypatch: pytest.MonkeyPatch, *, npm: str | None = "/usr/bin/npm") -> list[dict]:
    """Drive build_ui without a real npm; return the invocations it made."""
    monkeypatch.setattr(hatch_build.shutil, "which", lambda _name: npm)
    return []


def fake_runner(calls: list[dict]):  # noqa: ANN201
    def fake_run(cmd, **kwargs):  # noqa: ANN001, ANN202
        calls.append({"cmd": cmd, **kwargs})

    return fake_run


def make_clone(tmp_path: Path, *, node_modules: bool, lockfile: bool = True) -> Path:
    """A checkout as pip hands it to the build: with or without npm's install output."""
    repo = tmp_path / "clone"
    (repo / hatch_build.UI_WORKSPACE).mkdir(parents=True)
    (repo / hatch_build.UI_WORKSPACE / "package.json").write_text("{}", encoding="utf-8")
    (repo / "package.json").write_text('{"workspaces": ["apps/*"]}', encoding="utf-8")
    if lockfile:
        (repo / hatch_build.LOCKFILE).write_text('{"lockfileVersion": 3}', encoding="utf-8")
    if node_modules:
        (repo / hatch_build.NODE_MODULES).mkdir()
    return repo


def test_ui_build_uses_a_relative_runner_base(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The embedded bundle must talk to whatever origin serves it (§ single origin)."""
    calls = record_npm(monkeypatch)
    repo = make_clone(tmp_path, node_modules=True)

    hatch_build.build_ui(repo, run=fake_runner(calls))
    assert calls, "npm was never invoked"
    build = calls[-1]
    assert build["cmd"][1:] == ["run", "build", "-w", "apps/ui"]
    assert build["env"]["VITE_RUNNER_URL"] == ""
    assert build["cwd"] == str(repo)
    assert build["check"] is True


def test_a_clone_with_no_node_modules_is_installed_before_it_is_built(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The from-source install path, reproduced.

    `pipx install "git+…#subdirectory=boardex-app"` builds in a FRESH clone: no
    `node_modules`, so `npm run build -w apps/ui` exits 127 with "vite: not
    found". Only checkouts that had been npm-installed by hand ever worked.
    """
    calls = record_npm(monkeypatch)
    repo = make_clone(tmp_path, node_modules=False)

    hatch_build.build_ui(repo, run=fake_runner(calls))
    assert [call["cmd"][1:] for call in calls] == [
        ["ci"],
        ["run", "build", "-w", "apps/ui"],
    ], "the install must come first, and exactly once"
    assert calls[0]["cwd"] == str(repo), "dependencies install at the workspace ROOT"
    assert calls[0]["check"] is True, "a failed install must not fall through to the build"


def test_an_existing_node_modules_is_not_reinstalled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`npm ci` deletes and reinstalls the tree — never on a developer's checkout."""
    calls = record_npm(monkeypatch)
    repo = make_clone(tmp_path, node_modules=True)

    hatch_build.build_ui(repo, run=fake_runner(calls))
    assert [call["cmd"][1:] for call in calls] == [["run", "build", "-w", "apps/ui"]]


def test_a_tree_without_a_lockfile_installs_rather_than_failing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`npm ci` REQUIRES a lockfile; without one the resolving install is the
    only thing that can work at all."""
    calls = record_npm(monkeypatch)
    repo = make_clone(tmp_path, node_modules=False, lockfile=False)

    hatch_build.build_ui(repo, run=fake_runner(calls))
    assert calls[0]["cmd"][1:] == ["install"]


def test_no_npm_at_all_names_node_and_offers_the_wheel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The refusal a machine without Node gets: what it needs, or what to install
    instead — not a bare "npm is required"."""
    calls = record_npm(monkeypatch, npm=None)
    repo = make_clone(tmp_path, node_modules=False)

    with pytest.raises(RuntimeError) as err:
        hatch_build.build_ui(repo, run=fake_runner(calls))
    message = str(err.value)
    assert "building from source requires Node 20+" in message
    assert "prebuilt wheel" in message and hatch_build.WHEEL_INSTALL_HINT in message
    assert not calls, "nothing may be run when npm is absent"


def make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    dist = repo / hatch_build.UI_DIST
    (dist / "assets").mkdir(parents=True)
    # What marks a checkout as a checkout for prepare_bundle.
    (repo / hatch_build.UI_WORKSPACE / "package.json").write_text(
        '{"name": "@boardex/ui"}', encoding="utf-8"
    )
    (dist / "index.html").write_text("<html></html>", encoding="utf-8")
    (dist / "assets" / "app-abc.js").write_text("//", encoding="utf-8")
    schemas = repo / hatch_build.CONTRACT_SCHEMA
    schemas.mkdir(parents=True)
    (schemas / "events.schema.json").write_text("{}", encoding="utf-8")
    (schemas / "commands.schema.json").write_text("{}", encoding="utf-8")
    rules = repo / hatch_build.UDEV_RULES
    rules.parent.mkdir(parents=True)
    rules.write_text("# udev\n", encoding="utf-8")
    return repo


def test_bundle_assets_copies_the_ui_the_schemas_and_the_udev_rules(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    project = tmp_path / "boardex-app"
    project.mkdir()
    bundle = hatch_build.bundle_assets(repo, project, skip_ui_build=True)

    assert (bundle / "ui" / "index.html").is_file()
    assert (bundle / "ui" / "assets" / "app-abc.js").is_file()
    assert (bundle / "contract-schema" / "events.schema.json").is_file()
    assert (bundle / "contract-schema" / "commands.schema.json").is_file()
    assert (bundle / "udev" / "49-boardex-probes.rules").is_file()

    dist = repo / hatch_build.UI_DIST

    # A rebuild replaces the previous bundle rather than merging into it, so a
    # renamed hashed asset can never linger.
    (dist / "assets" / "app-abc.js").unlink()
    (dist / "assets" / "app-def.js").write_text("//", encoding="utf-8")
    hatch_build.bundle_assets(repo, project, skip_ui_build=True)
    assert not (bundle / "ui" / "assets" / "app-abc.js").exists()
    assert (bundle / "ui" / "assets" / "app-def.js").is_file()


def test_bundle_assets_without_a_built_ui_says_what_to_run(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / "apps" / "ui").mkdir(parents=True)
    project = tmp_path / "boardex-app"
    project.mkdir()
    with pytest.raises(RuntimeError, match="npm run build"):
        hatch_build.bundle_assets(repo, project, skip_ui_build=True)


def test_a_wheel_without_the_contract_schemas_is_refused(tmp_path: Path) -> None:
    """Shipping a runner that cannot validate its own events is not shippable."""
    repo = make_repo(tmp_path)
    (repo / hatch_build.CONTRACT_SCHEMA / "events.schema.json").unlink()
    project = tmp_path / "boardex-app"
    project.mkdir()
    with pytest.raises(RuntimeError, match="contract schemas"):
        hatch_build.bundle_assets(repo, project, skip_ui_build=True)


def test_an_sdist_build_verifies_the_bundle_it_was_handed(tmp_path: Path) -> None:
    """The no-monorepo path (an sdist build) must verify, not assume.

    Nothing there can regenerate the bundle, so the only question is whether
    what travelled in the archive is complete — and a wheel with a UI but no
    contract schemas installs fine and then cannot emit an event, which is the
    failure this refuses to ship.
    """
    project = tmp_path / "boardex-app"
    bundle = project / hatch_build.BUNDLE_DIR
    (bundle / "ui").mkdir(parents=True)
    (bundle / "ui" / "index.html").write_text("<html></html>", encoding="utf-8")
    no_monorepo = tmp_path / "elsewhere"
    no_monorepo.mkdir()

    with pytest.raises(RuntimeError, match="contract-schema"):
        hatch_build.prepare_bundle(no_monorepo, project)

    (bundle / "contract-schema").mkdir()
    (bundle / "contract-schema" / "events.schema.json").write_text("{}", encoding="utf-8")
    # Complete: taken as found, no build attempted, no raise.
    assert hatch_build.prepare_bundle(no_monorepo, project) == bundle


def test_a_build_with_neither_a_monorepo_nor_a_bundle_names_both_halves(tmp_path: Path) -> None:
    project = tmp_path / "boardex-app"
    project.mkdir()
    with pytest.raises(RuntimeError) as err:
        hatch_build.prepare_bundle(tmp_path / "elsewhere", project)
    assert "ui" in str(err.value) and "contract-schema" in str(err.value)


def test_the_monorepo_path_is_verified_too(tmp_path: Path) -> None:
    """Same verification after a real build — one path, one post-condition."""
    repo = make_repo(tmp_path)
    project = tmp_path / "boardex-app"
    project.mkdir()
    assert hatch_build.missing_bundle_parts(
        hatch_build.prepare_bundle(repo, project, skip_ui_build=True)
    ) == []


def test_missing_bundle_parts_names_each_half(tmp_path: Path) -> None:
    assert hatch_build.missing_bundle_parts(tmp_path) == ["ui", "contract-schema"]
    (tmp_path / "ui").mkdir()
    (tmp_path / "ui" / "index.html").write_text("<html></html>", encoding="utf-8")
    assert hatch_build.missing_bundle_parts(tmp_path) == ["contract-schema"]


def test_the_bundled_schemas_are_the_repos_own(tmp_path: Path) -> None:
    """A verbatim copy of the emitted bridge (BIBLE §3), never an edited one."""
    project = tmp_path / "boardex-app"
    project.mkdir()
    bundle = hatch_build.bundle_assets(REPO_ROOT, project, skip_ui_build=True)
    for schema in (REPO_ROOT / hatch_build.CONTRACT_SCHEMA).glob("*.json"):
        copied = bundle / "contract-schema" / schema.name
        assert copied.read_bytes() == schema.read_bytes(), schema.name


def test_ui_assets_read_the_installed_package(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ui_assets, "bundled_dir", lambda: tmp_path)
    assert ui_assets.ui_bundle_dir() is None
    assert ui_assets.udev_rules_path() is None
    assert ui_assets.contract_schema_dir() is None

    (tmp_path / "ui").mkdir()
    (tmp_path / "ui" / "index.html").write_text("<html></html>", encoding="utf-8")
    (tmp_path / "udev").mkdir()
    (tmp_path / "udev" / "49-boardex-probes.rules").write_text("#", encoding="utf-8")
    (tmp_path / "contract-schema").mkdir()
    (tmp_path / "contract-schema" / "events.schema.json").write_text("{}", encoding="utf-8")
    assert ui_assets.ui_bundle_dir() == tmp_path / "ui"
    assert ui_assets.udev_rules_path() == tmp_path / "udev" / "49-boardex-probes.rules"
    assert ui_assets.contract_schema_dir() == tmp_path / "contract-schema"
