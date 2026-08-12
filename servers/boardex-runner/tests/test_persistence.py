"""Runner state that survives a restart: ~/.boardex/{profiles,credentials}.json.

The properties pinned here are the ones a user would notice breaking — a key or
a board that has to be entered again — plus the ones nobody notices until the
day they matter: the file mode, the atomic replace, and the refusal to follow a
symlink where the credentials file should be.

Every test runs against a tmpdir state directory (the autouse `isolated_state_dir`
fixture in conftest), never the developer's real one.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path
from typing import Any, Iterator

import pytest

from boardex_runner import credentials, persistence
from boardex_runner.artifacts import ArtifactStore
from boardex_runner.clock import VirtualClock
from boardex_runner.fake_bench import FakeBench, fake_board_profile
from boardex_runner.server import RunnerApp

from conftest import run

MODEL = "openrouter/anthropic/claude-sonnet-4.6"
KEY = "sk-or-v1-persisted-9f3a2b71"


@pytest.fixture(autouse=True)
def clean_store(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Same discipline as the credentials suite: the store is module state, so
    configure per test and empty it after, with the providers' env vars cleared
    so no developer's shell can seed these tests. Both are cleared because
    resolve_key's fallback reads the environment for ANY provider, advertised or
    not — a developer with ANTHROPIC_API_KEY exported would otherwise see a
    different answer from CI."""
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    yield
    credentials.configure([])


def creds_file() -> Path:
    return persistence.state_dir() / persistence.CREDENTIALS_FILE


def profiles_file() -> Path:
    return persistence.state_dir() / persistence.PROFILES_FILE


# -- the state directory -----------------------------------------------------------


def test_state_dir_defaults_to_home_and_is_not_created_by_reading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The default is ~/.boardex — asserted against a FAKE home, never the
    developer's own. A test that expands ~ for real is one chmod or one stray
    write away from touching somebody's actual state directory."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))  # expanduser's Windows source
    monkeypatch.delenv(persistence.STATE_DIR_ENV, raising=False)
    assert persistence.state_dir() == home / ".boardex"

    # An override is expanded too, and merely resolving it creates nothing: a
    # runner that never saves anything leaves no trace on the filesystem.
    monkeypatch.setenv(persistence.STATE_DIR_ENV, "~/somewhere-else")
    assert persistence.state_dir() == home / "somewhere-else"
    assert not (home / "somewhere-else").exists()
    assert list(home.iterdir()) == []


# -- credentials: round trip, precedence, removal ------------------------------------


def test_a_dashboard_key_survives_a_restart() -> None:
    """The gap this feature closes: paste once, restart, still configured."""
    credentials.configure([MODEL])
    assert credentials.set_key("openrouter", KEY) is None

    # "Restart": configure() is exactly what a fresh process runs at boot.
    credentials.configure([MODEL])
    assert credentials.advertise() == [
        {"provider": "openrouter", "configured": True, "hint": "…2b71"}
    ]
    assert credentials.resolve_key(MODEL) == KEY
    # And it is readable JSON the owner can inspect or delete, not an opaque blob.
    assert json.loads(creds_file().read_text(encoding="utf-8")) == {"openrouter": KEY}


def test_the_file_beats_the_environment_at_boot(monkeypatch: pytest.MonkeyPatch) -> None:
    """PRECEDENCE, as implemented: a stored key wins over an exported one.

    Pasting into the dashboard is the more recent and more specific act; an
    exported variable is often inherited from a shell profile nobody has looked
    at in months. The other order would make the dashboard silently ineffective
    for exactly the people who already have the variable set.
    """
    credentials.configure([MODEL])
    assert credentials.set_key("openrouter", KEY) is None

    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-from-the-environment")
    credentials.configure([MODEL])
    assert credentials.resolve_key(MODEL) == KEY
    assert credentials.advertise()[0]["hint"] == "…2b71"


def test_the_environment_seeds_a_provider_the_file_says_nothing_about(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other half of the precedence rule: env-only setups are untouched."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-from-the-environment")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-from-the-environment")
    persistence.write_json(creds_file(), {"openrouter": KEY})

    credentials.configure([MODEL, "anthropic/claude-sonnet-4-6"])
    assert credentials.resolve_key(MODEL) == KEY  # file
    assert credentials.resolve_key("anthropic/claude-sonnet-4-6") == (
        "sk-ant-from-the-environment"  # env, because the file has no entry
    )


def test_an_env_seed_is_never_written_to_the_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The escape hatch the README promises stays true: unset the variable,
    restart, and the key is gone. It could only be broken by the runner quietly
    copying an exported key onto disk — so nothing but a deliberate set writes.

    Two providers, because "the file was never created" is not much of a pin:
    a store that persisted env seeds would still pass it as long as nothing was
    ever set. Here openrouter is seeded from the environment and anthropic is
    set deliberately, and the file must hold anthropic ALONE — the exact
    contents, not a subset, so a seed leaking into the write is a failure and
    not a silent pass.
    """
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-from-the-environment")
    credentials.configure([MODEL, "anthropic/claude-sonnet-4-6"])
    assert credentials.advertise()[0]["configured"] is True
    # Nothing set yet, so nothing written at all.
    assert not creds_file().exists()

    assert credentials.set_key("anthropic", "sk-ant-set-in-the-dashboard") is None
    assert json.loads(creds_file().read_text(encoding="utf-8")) == {
        "anthropic": "sk-ant-set-in-the-dashboard"
    }

    # A Remove re-seeds openrouter from env in memory (standing ruling) — and
    # that re-seed must not reach the file either.
    assert credentials.delete_key("openrouter") is None
    assert credentials.resolve_key(MODEL) == "sk-or-v1-from-the-environment"
    assert json.loads(creds_file().read_text(encoding="utf-8")) == {
        "anthropic": "sk-ant-set-in-the-dashboard"
    }

    monkeypatch.delenv("OPENROUTER_API_KEY")
    credentials.configure([MODEL, "anthropic/claude-sonnet-4-6"])
    assert credentials.advertise()[0] == {"provider": "openrouter", "configured": False}
    assert credentials.resolve_key(MODEL) is None
    # The deliberately-set one is of course still there.
    assert credentials.resolve_key("anthropic/claude-sonnet-4-6") == (
        "sk-ant-set-in-the-dashboard"
    )


def test_remove_survives_a_restart_and_still_re_seeds_from_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Remove has to be durable or it is theater — the next boot would load the
    key straight back out of the file. The re-seed pinned by the credentials
    suite is unchanged: it is a memory fallback to the operator's launch
    configuration, not a resurrection of what was deleted."""
    credentials.configure([MODEL])
    assert credentials.set_key("openrouter", KEY) is None
    assert credentials.delete_key("openrouter") is None
    assert json.loads(creds_file().read_text(encoding="utf-8")) == {}

    credentials.configure([MODEL])
    assert credentials.advertise() == [{"provider": "openrouter", "configured": False}]

    # With a variable exported, the same restart lands on the env key.
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-from-the-environment")
    credentials.configure([MODEL])
    assert credentials.resolve_key(MODEL) == "sk-or-v1-from-the-environment"


def test_a_key_for_an_unadvertised_provider_is_preserved_not_erased() -> None:
    """A runner booted with a narrower AGENT_MODELS must not wipe the key
    another launch stored. It is not advertised and not resolvable here — it is
    simply still in the file when the next write happens."""
    persistence.write_json(creds_file(), {"openrouter": KEY, "anthropic": "sk-ant-other"})
    credentials.configure([MODEL])  # openrouter only

    assert credentials.advertise() == [
        {"provider": "openrouter", "configured": True, "hint": "…2b71"}
    ]
    assert credentials.resolve_key("anthropic/claude-sonnet-4-6") is None

    assert credentials.set_key("openrouter", "sk-or-v1-replacement-key") is None
    assert json.loads(creds_file().read_text(encoding="utf-8")) == {
        "openrouter": "sk-or-v1-replacement-key",
        "anthropic": "sk-ant-other",
    }


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
def test_the_credentials_file_is_owner_only() -> None:
    """0600 from creation, never open-then-chmod: between those two calls the
    file would exist world-readable with a key already in it."""
    credentials.configure([MODEL])
    assert credentials.set_key("openrouter", KEY) is None
    assert stat.S_IMODE(creds_file().stat().st_mode) == 0o600
    # The directory it rests in is owner-only too, when we created it.
    assert stat.S_IMODE(persistence.state_dir().stat().st_mode) == 0o700


def test_profiles_json_is_not_secret_and_is_written_readable() -> None:
    """Board profiles are repo paths and bench wiring — deliberately normal
    mode, so the 0600 on the credentials file means something specific."""
    persistence.write_json(profiles_file(), [fake_board_profile()])
    if sys.platform != "win32":
        assert stat.S_IMODE(profiles_file().stat().st_mode) == 0o644


# -- atomicity, corruption, symlinks --------------------------------------------------


def test_a_crash_between_temp_write_and_replace_leaves_the_original_intact(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reason for temp-then-replace: the file a reader sees is always one
    whole document. Simulate the crash at the only window that exists — after
    the temp file is written, before the rename lands."""
    path = profiles_file()
    persistence.write_json(path, [{"id": "bp_original"}])
    original = path.read_bytes()

    def boom(src: Any, dst: Any) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(persistence.os, "replace", boom)
    assert persistence.write_json(path, [{"id": "bp_replacement"}]) is False

    # The old profile set is byte-identical: nothing ever opened it for writing.
    assert path.read_bytes() == original
    # And the half-written temp file is not left behind to be mistaken for state.
    assert list(persistence.state_dir().glob("*.tmp-*")) == []


def test_a_planted_temp_file_or_symlink_is_refused_never_followed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The temp file is the write's soft spot: it is created by us, with our
    mode and our contents, at a path in a directory other local processes can
    write to. Plant a symlink at that name and a naive O_CREAT would follow it,
    delivering the key wherever the link points — outside the state directory,
    and with the 0600 landing on a file we did not create.

    O_EXCL refuses ANY existing path (a symlink included, dangling or not) and
    O_NOFOLLOW refuses links specifically. The write reports failure and writes
    nothing rather than writing somewhere else.
    """
    target = tmp_path / "attacker-would-read-this"
    path = creds_file()
    persistence.state_dir().mkdir(parents=True, exist_ok=True)
    planted = path.with_name(path.name + ".tmp-planted")
    planted.symlink_to(target)
    # The real temp name is unguessable per write, so pin the refusal through
    # the one seam that makes it deterministic.
    monkeypatch.setattr(persistence, "temp_path_for", lambda _p: planted)

    assert persistence.write_json(path, {"openrouter": KEY}, mode=0o600) is False
    assert not target.exists()  # nothing followed the link
    assert not path.exists()  # and nothing landed at the destination either
    assert planted.is_symlink()  # the plant was refused, not consumed

    # A plain regular file squatting on the temp name is refused the same way:
    # we only ever write a file we created.
    planted.unlink()
    planted.write_text("squatter", encoding="utf-8")
    assert persistence.write_json(path, {"openrouter": KEY}, mode=0o600) is False
    assert planted.read_text(encoding="utf-8") == "squatter"

    # And with the plant cleared, the same write lands: the refusal is about
    # the planted path, not a store that has stopped working.
    planted.unlink()
    assert persistence.write_json(path, {"openrouter": KEY}, mode=0o600) is True
    assert json.loads(path.read_text(encoding="utf-8")) == {"openrouter": KEY}


def test_temp_names_are_unique_per_write() -> None:
    """A predictable temp name is a path an attacker can re-plant between
    writes, turning O_EXCL from a one-off refusal into a permanent denial of
    service on the store."""
    path = creds_file()
    names = {persistence.temp_path_for(path).name for _ in range(50)}
    assert len(names) == 50
    assert all(name.startswith(path.name + ".tmp-") for name in names)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
@pytest.mark.skipif(os.geteuid() == 0, reason="root reads through any mode")
def test_an_unreadable_credentials_file_is_never_written_over(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """AN UNREADABLE FILE IS NOT AN EMPTY ONE.

    If a boot that cannot read the store proceeded as if it were empty, the
    next set_key would write a one-entry store over a file that still holds
    every other provider's key — a permission problem silently promoted to key
    loss. So the session runs memory-only and the file is left exactly as it
    was, ready to work again when whatever broke is fixed.
    """
    persistence.write_json(
        creds_file(),
        {"openrouter": KEY, "anthropic": "sk-ant-the-other-providers-key"},
        mode=0o600,
    )
    intact = creds_file().read_bytes()
    creds_file().chmod(0o000)

    with caplog.at_level("WARNING"):
        credentials.configure([MODEL, "anthropic/claude-sonnet-4-6"])
    # The boot survives and simply has no keys.
    assert credentials.advertise() == [
        {"provider": "openrouter", "configured": False},
        {"provider": "anthropic", "configured": False},
    ]
    assert any("will not persist" in r.getMessage() for r in caplog.records)

    # THE PIN: a set in this session works in memory and writes NOTHING.
    assert credentials.set_key("openrouter", "sk-or-v1-set-while-unreadable") is None
    assert credentials.resolve_key(MODEL) == "sk-or-v1-set-while-unreadable"
    creds_file().chmod(0o600)
    assert creds_file().read_bytes() == intact


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
@pytest.mark.skipif(os.geteuid() == 0, reason="root reads through any mode")
def test_an_unreadable_profiles_file_is_never_written_over() -> None:
    """Same rule on the other file: a transient read failure at boot costs
    persistence for the session, not the profiles already on disk."""
    persistence.write_json(
        profiles_file(),
        [dict(fake_board_profile(), id="bp_one"), dict(fake_board_profile(), id="bp_two")],
    )
    intact = profiles_file().read_bytes()
    profiles_file().chmod(0o000)

    store = persistence.ProfileStore(profiles_file())
    app = _app(profile_store=store)
    assert store.writable is False

    app.save_profile(dict(fake_board_profile(), id="bp_saved_while_unreadable"))
    profiles_file().chmod(0o644)
    assert profiles_file().read_bytes() == intact


def test_a_removal_that_cannot_be_written_reports_failure_instead_of_lying(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A removal that only happened in memory is the runner's worst available
    lie: the operator is told the key is gone, stops thinking about it, and the
    next boot loads it back out of the file and spends it. So a failed write on
    DELETE is surfaced (500) and the store is put back the way it was — a store
    that says "configured" and a file that holds the key are at least the same
    fact, and one the operator can act on.

    Note what is NOT claimed: the key is still on disk afterwards, because the
    write genuinely failed. What the pin forbids is the combination that
    matters — success reported, key resurrected.
    """
    credentials.configure([MODEL])
    assert credentials.set_key("openrouter", KEY) is None

    # A switch rather than monkeypatch.undo(): undo() would also revert the
    # conftest fixture's BOARDEX_STATE_DIR (one shared MonkeyPatch per test) and
    # point the rest of this test at the developer's real home directory.
    real_replace = persistence.os.replace
    failing = {"now": True}

    def maybe_boom(src: Any, dst: Any) -> Any:
        if failing["now"]:
            raise OSError(30, "Read-only file system")
        return real_replace(src, dst)

    monkeypatch.setattr(persistence.os, "replace", maybe_boom)
    failure = credentials.delete_key("openrouter")
    assert failure is not None and failure.status == 500
    # No half-removed store: what it advertises matches what a restart gives.
    assert credentials.advertise() == [
        {"provider": "openrouter", "configured": True, "hint": "…2b71"}
    ]
    assert credentials.resolve_key(MODEL) == KEY

    failing["now"] = False
    credentials.configure([MODEL])
    assert credentials.resolve_key(MODEL) == KEY  # exactly what the 500 said

    # With the disk working, the same Remove lands and stays gone.
    assert credentials.delete_key("openrouter") is None
    credentials.configure([MODEL])
    assert credentials.advertise() == [{"provider": "openrouter", "configured": False}]


def test_a_memory_only_session_still_removes_honestly(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The other side of that rule: when persistence was refused at boot, the
    file is not a source of truth for the next boot either (the same read
    refuses it the same way), so there is nothing a removal could fail to erase
    — and Remove answers success rather than a 500 nobody can act on."""
    persistence.state_dir().mkdir(parents=True, exist_ok=True)
    creds_file().symlink_to(tmp_path / "elsewhere.json")

    with caplog.at_level("WARNING"):
        credentials.configure([MODEL])
    assert credentials.set_key("openrouter", KEY) is None
    assert credentials.delete_key("openrouter") is None
    assert credentials.advertise() == [{"provider": "openrouter", "configured": False}]


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX open flags")
def test_a_credentials_path_that_is_not_a_regular_file_is_refused(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The fstat half of the read guard: O_NOFOLLOW catches links, and the
    stat on the descriptor we hold catches everything else that is not a
    regular file (a directory, a fifo someone left there). Refused, logged,
    memory-only — never crashed, never treated as empty-and-writable."""
    creds_file().mkdir(parents=True)

    with caplog.at_level("WARNING"):
        credentials.configure([MODEL])
    assert credentials.advertise() == [{"provider": "openrouter", "configured": False}]
    assert credentials.set_key("openrouter", KEY) is None
    assert creds_file().is_dir()  # untouched
    assert any("will not persist" in r.getMessage() for r in caplog.records)


def test_a_corrupt_state_file_is_moved_aside_and_the_runner_boots_clean(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Never crash on state files: a hand-edited or truncated file costs the
    state in it, not the ability to start. What was in there stays on disk."""
    persistence.state_dir().mkdir(parents=True, exist_ok=True)
    creds_file().write_text("{not json at all", encoding="utf-8")
    profiles_file().write_text('"a string, not a profile array"', encoding="utf-8")

    with caplog.at_level("WARNING"):
        credentials.configure([MODEL])
        store = persistence.ProfileStore(profiles_file())
        assert store.load() == {}

    assert credentials.advertise() == [{"provider": "openrouter", "configured": False}]
    assert not creds_file().exists()
    aside = sorted(persistence.state_dir().glob("*.corrupt-*"))
    assert len(aside) == 2  # both, contents kept
    assert "{not json at all" in (
        next(p for p in aside if p.name.startswith("credentials")).read_text(encoding="utf-8")
    )
    # One honest line each, naming paths only.
    assert sum("moved to" in record.message for record in caplog.records) == 2


def test_a_symlinked_credentials_file_is_refused_not_followed(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """THE SYMLINK RULE, as implemented: refuse.

    Nothing here would damage a symlink target — os.replace swaps the LINK and
    rename moves the LINK aside — so this is not about damage. A credentials
    file is only owner-only-secret if we know what it is, and a link points at a
    file whose mode and directory we never set. So we neither read it nor
    replace it: the session works, it just does not persist, and it says so.

    The refusal happens INSIDE the open (O_NOFOLLOW, then fstat on the
    descriptor we hold) rather than in an is_symlink() check followed by a
    read. A check-then-read has a window: the attacker plants a regular file,
    waits for the check to pass, and swaps the symlink in before the read. An
    open that refuses links has no window to aim at.
    """
    target = tmp_path / "elsewhere.json"
    target.write_text(json.dumps({"openrouter": "sk-or-v1-someone-elses-key"}), encoding="utf-8")
    persistence.state_dir().mkdir(parents=True, exist_ok=True)
    creds_file().symlink_to(target)

    with caplog.at_level("WARNING"):
        credentials.configure([MODEL])
        # Not read: the linked key is not adopted as ours.
        assert credentials.advertise() == [{"provider": "openrouter", "configured": False}]
        assert credentials.set_key("openrouter", KEY) is None

    # The key works for this session...
    assert credentials.resolve_key(MODEL) == KEY
    # ...and neither the link nor what it points at was touched.
    assert creds_file().is_symlink()
    assert os.readlink(creds_file()) == str(target)
    assert json.loads(target.read_text(encoding="utf-8")) == {
        "openrouter": "sk-or-v1-someone-elses-key"
    }
    assert any("will not persist" in record.getMessage() for record in caplog.records)
    assert not any(KEY in record.getMessage() for record in caplog.records)


# -- board profiles ------------------------------------------------------------------


def _app(**kwargs: Any) -> RunnerApp:
    return RunnerApp(
        bench_factory=lambda: FakeBench(),
        clock_factory=lambda: VirtualClock(speed=2000.0),
        artifacts=ArtifactStore(),
        **kwargs,
    )


def test_saved_board_profiles_are_written_through_and_reloaded() -> None:
    """The plain gap: a profile created in the dashboard used to vanish on
    restart, and a run against its id then resolved to a profile whose repoPath
    does not exist."""
    store = persistence.ProfileStore(profiles_file())
    app = _app(profile_store=store)

    created = dict(fake_board_profile(), id="bp_created_in_the_ui", name="Bench 2")
    app.save_profile(created)
    # Write-through, not a flush at exit: a Ctrl-C runner never gets to flush.
    # And ONLY what the user saved — the synthetic fallback profile this runner
    # is also serving comes back on its own every boot (see the F5 pin below).
    assert [p["id"] for p in json.loads(profiles_file().read_text(encoding="utf-8"))] == [
        "bp_created_in_the_ui"
    ]

    # An edit to an existing profile is written through the same way.
    app.save_profile(dict(created, name="Bench 2 (edited)"))

    restarted = _app(profile_store=persistence.ProfileStore(profiles_file()))
    assert restarted.board_profiles["bp_created_in_the_ui"]["name"] == "Bench 2 (edited)"
    assert set(restarted.board_profiles) == {"bp_created_in_the_ui"}


def test_launch_configuration_wins_over_a_saved_profile_of_the_same_id() -> None:
    """A BENCH=real profile comes from bench.json and describes the hardware
    actually wired to this host. A browser must not be able to leave a stale
    entry behind that a restart then serves as the bench's own profile."""
    persistence.write_json(
        profiles_file(),
        [
            dict(fake_board_profile(), name="saved, and stale"),
            dict(fake_board_profile(), id="bp_saved_only", name="still here"),
        ],
    )
    app = _app(
        profile_store=persistence.ProfileStore(profiles_file()),
        board_profiles=[dict(fake_board_profile(), name="from bench.json")],
    )
    assert app.board_profiles["bp_nucleo_f303re"]["name"] == "from bench.json"
    # Profiles the launch config says nothing about are still served.
    assert app.board_profiles["bp_saved_only"]["name"] == "still here"


def test_an_unknown_profile_id_falls_back_to_the_launch_profile() -> None:
    """The fallback drives PHYSICAL HARDWARE on a real bench, so it has to be
    the profile this runner was launched with. Resolving it to a saved profile
    instead — whatever a browser once stored, with another board's target and
    another repo's firmware — is the one mistake here that costs a device.

    Pinned as a property of the run, not of dict ordering: a saved profile is
    present and sorts before the launch one by insertion history, and an
    unknown id must still land on bench.json's.
    """
    persistence.write_json(
        profiles_file(), [dict(fake_board_profile(), id="bp_saved", name="somebody else's board")]
    )
    app = _app(
        profile_store=persistence.ProfileStore(profiles_file()),
        board_profiles=[dict(fake_board_profile(), id="bp_bench", name="the wired hardware")],
    )

    async def scenario() -> None:
        run_id = app.create_run("bring up BME280", "bp_does_not_exist")
        assert isinstance(run_id, str)
        try:
            assert app.runs[run_id].profile["id"] == "bp_bench"
        finally:
            for engine in app.runs.values():
                engine.dispose()

    run(scenario())
    # The launch profile also leads the list the dashboard renders.
    assert list(app.board_profiles) == ["bp_bench", "bp_saved"]


def test_only_user_saved_profiles_are_written_to_the_file() -> None:
    """The store holds what the USER saved. The synthetic fallback profile and
    the launch config re-supply themselves every boot; a copy of either in the
    file would outlive its source and shadow a bench.json the operator later
    edits — the launch-wins rule quietly inverted by a stale write."""
    store = persistence.ProfileStore(profiles_file())
    app = _app(
        profile_store=store,
        board_profiles=[dict(fake_board_profile(), id="bp_bench", name="from bench.json")],
    )
    app.save_profile(dict(fake_board_profile(), id="bp_user", name="mine"))

    written = json.loads(profiles_file().read_text(encoding="utf-8"))
    assert [profile["id"] for profile in written] == ["bp_user"]

    # Same with no launch config at all: the fallback profile the runner is
    # serving is not the user's, and does not become a saved one.
    other = persistence.ProfileStore(profiles_file().with_name("other.json"))
    plain = _app(profile_store=other)
    assert set(plain.board_profiles) == {"bp_nucleo_f303re"}
    plain.save_profile(dict(fake_board_profile(), id="bp_user2", name="mine too"))
    assert [
        profile["id"]
        for profile in json.loads(other.path.read_text(encoding="utf-8"))
    ] == ["bp_user2"]


def test_a_runner_built_without_a_store_touches_no_disk() -> None:
    """The pre-persistence behavior is still reachable and is what every direct
    construction gets — no test, and no embedder, reads a user's home by
    accident."""
    app = _app()
    app.save_profile(dict(fake_board_profile(), id="bp_memory_only"))
    assert not profiles_file().exists()
    assert set(app.board_profiles) == {"bp_nucleo_f303re", "bp_memory_only"}


def test_idless_saved_entries_are_dropped_rather_than_failing_the_boot() -> None:
    persistence.write_json(
        profiles_file(), [{"name": "no id"}, "not an object", dict(fake_board_profile())]
    )
    store = persistence.ProfileStore(profiles_file())
    assert set(store.load()) == {"bp_nucleo_f303re"}
