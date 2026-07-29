"""The build hooks: dependency resolution and what lands in the wheel."""

from __future__ import annotations

import sys
from pathlib import Path

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


def test_siblings_resolve_to_local_paths_inside_a_checkout(tmp_path: Path) -> None:
    deps = hatch_build.sibling_dependencies(make_monorepo(tmp_path))
    assert len(deps) == 4
    for dep in deps:
        assert " @ file://" in dep
    # The runner carries [agent] — `boardex up` defaults to BENCH=agent.
    assert any(dep.startswith("boardex-runner[agent] @ file://") for dep in deps)
    assert (tmp_path / "servers/boardex-core").resolve().as_uri() in deps[0]


def test_siblings_fall_back_to_version_pins_without_a_checkout(tmp_path: Path) -> None:
    deps = hatch_build.sibling_dependencies(tmp_path)
    assert deps == [
        "boardex-core==0.1.0",
        "boardex-logic==0.1.0",
        "boardex-target==0.1.0",
        "boardex-runner[agent]==0.1.0",
    ]


def test_a_partial_checkout_is_not_treated_as_a_checkout(tmp_path: Path) -> None:
    """All four or none: half local paths and half pins would resolve two
    different versions of the same lockstep set."""
    root = make_monorepo(tmp_path)
    (root / "servers/boardex-logic/pyproject.toml").unlink()
    assert all("file://" not in dep for dep in hatch_build.sibling_dependencies(root))


def test_the_pinned_version_tracks_servers_version() -> None:
    """The four server packages version in lockstep via servers/VERSION."""
    recorded = (REPO_ROOT / "servers" / "VERSION").read_text(encoding="utf-8").strip()
    assert hatch_build.SERVERS_VERSION == recorded


def test_ui_build_uses_a_relative_runner_base(tmp_path: Path) -> None:
    """The embedded bundle must talk to whatever origin serves it (§ single origin)."""
    calls: list[dict] = []

    def fake_run(cmd, **kwargs):  # noqa: ANN001, ANN202
        calls.append({"cmd": cmd, **kwargs})

    hatch_build.build_ui(tmp_path, run=fake_run)
    assert calls, "npm was never invoked"
    call = calls[0]
    assert call["cmd"][1:] == ["run", "build", "-w", "apps/ui"]
    assert call["env"]["VITE_RUNNER_URL"] == ""
    assert call["cwd"] == str(tmp_path)
    assert call["check"] is True


def make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    dist = repo / hatch_build.UI_DIST
    (dist / "assets").mkdir(parents=True)
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
