"""`boardex doctor`: what it reports, and that it never blocks."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from boardex_core.doctor import CheckResult

from boardex_app import doctor


def test_provider_key_is_a_warning_not_a_failure() -> None:
    absent = doctor.check_provider_key({})
    assert absent.status == "warn"
    assert "still" in absent.detail  # says what still works without a key

    present = doctor.check_provider_key({"OPENROUTER_API_KEY": "sk-or-test"})
    assert present.status == "ok"
    assert "OPENROUTER_API_KEY" in present.detail
    # The key's VALUE is never echoed anywhere in the report.
    assert "sk-or-test" not in doctor.format_report([present])


def test_the_key_story_leads_with_the_dashboard_not_the_shell() -> None:
    """The runner holds a credential store (PR #18), so a missing key is not an
    instruction to open a shell — the primary path is Settings → Model provider,
    and the environment is the fallback that boots the runner pre-configured."""
    absent = doctor.check_provider_key({})
    fix = doctor.fix_command(absent, "Linux")
    assert "Settings → Model provider" in absent.detail
    assert "Settings → Model provider" in fix
    assert fix.index("Settings") < fix.index("export"), "the no-shell path leads"
    # The environment is still named as the fallback, never dropped.
    assert "export" in fix

    # The default runner reads OPENROUTER_API_KEY, so that is what "already
    # configured at boot" looks like for it.
    seeded = doctor.check_provider_key({"OPENROUTER_API_KEY": "sk-or-test"})
    assert "boots configured" in seeded.detail


def test_blank_key_reads_as_absent() -> None:
    assert doctor.check_provider_key({"ANTHROPIC_API_KEY": "   "}).status == "warn"


def test_the_key_check_follows_this_runners_advertised_models() -> None:
    """AGENT_MODELS decides which variable matters — derived as the store derives it.

    A fixed list lies both ways on a runner pointed at a non-default provider:
    it calls an irrelevant OPENROUTER_API_KEY a pass, and it names the wrong
    variable in the fix.
    """
    anthropic_only = {"AGENT_MODELS": "anthropic/claude-sonnet-4.6"}
    assert doctor.expected_key_vars(anthropic_only) == ["ANTHROPIC_API_KEY"]

    irrelevant = doctor.check_provider_key({**anthropic_only, "OPENROUTER_API_KEY": "sk-or-x"})
    assert irrelevant.status == "warn", "a key for a provider this runner never calls is not a pass"
    assert "ANTHROPIC_API_KEY" in irrelevant.detail
    assert "ANTHROPIC_API_KEY" in doctor.fix_command(irrelevant, "Linux")

    right_one = doctor.check_provider_key({**anthropic_only, "ANTHROPIC_API_KEY": "sk-ant-x"})
    assert right_one.status == "ok"

    # Several advertised models -> every provider they name, in order, deduped.
    assert doctor.expected_key_vars(
        {"AGENT_MODELS": "openrouter/anthropic/claude-sonnet-4.6, anthropic/claude-opus, openrouter/x"}
    ) == ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]


def test_an_unset_agent_models_names_exactly_the_default_providers_key() -> None:
    """Unset is not underivable: the runner then advertises DEFAULT_MODEL alone.

    Exactly one provider's key can ever be read in that configuration, so
    naming it is precise — the same claim /health makes — and the previous
    "accept any of five" was the check failing to answer a question it could.
    """
    credentials = pytest.importorskip("boardex_runner.credentials")
    assert credentials.DEFAULT_MODEL.startswith("openrouter/")
    assert doctor.expected_key_vars({}) == ["OPENROUTER_API_KEY"]

    # The reviewer's measured scenario: default runner, a real key exported —
    # for a provider it will never call. That is a warning, naming the one it will.
    misdirected = doctor.check_provider_key({"ANTHROPIC_API_KEY": "sk-ant-x"})
    assert misdirected.status == "warn"
    assert "OPENROUTER_API_KEY" in misdirected.detail
    assert "OPENROUTER_API_KEY" in doctor.fix_command(misdirected, "Linux")
    assert doctor.check_provider_key({"OPENROUTER_API_KEY": "sk-or-x"}).status == "ok"


def test_what_doctor_names_is_what_health_would_advertise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same configuration, same single provider — read off the store itself."""
    credentials = pytest.importorskip("boardex_runner.credentials")
    monkeypatch.delenv("AGENT_MODELS", raising=False)
    try:
        credentials.configure()  # exactly what the runner does at boot
        advertised = [entry["provider"] for entry in credentials.advertise()]
        assert advertised == ["openrouter"]
        assert doctor.expected_key_vars({}) == [
            credentials.env_var_for(provider) for provider in advertised
        ]
    finally:
        credentials.configure([])


def test_the_fixed_list_is_only_for_the_genuinely_underivable() -> None:
    """Two cases, both named in the docstring, neither guessable.

    A bare model string derives no provider (the store says the same), and an
    AGENT_MODELS that is set-but-empty advertises no models at all — the
    default covers an ABSENT variable, exactly as credentials._models_from_env
    has it.
    """
    assert doctor.expected_key_vars({"AGENT_MODELS": "some-local-model"}) == list(
        doctor.PROVIDER_KEY_ENV
    )
    assert doctor.expected_key_vars({"AGENT_MODELS": ""}) == list(doctor.PROVIDER_KEY_ENV)
    # In that state any known provider key counts, because none can be ruled out.
    assert doctor.check_provider_key({"AGENT_MODELS": "local", "OPENAI_API_KEY": "sk-x"}).status == "ok"


def test_a_runner_that_will_not_import_still_gets_a_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The half-broken install is when doctor matters most: it must not crash."""
    # None in sys.modules is the documented "this import is halted" marker; the
    # submodule entry alone would not do it, since `from boardex_runner import
    # credentials` would still find the attribute on the already-imported package.
    monkeypatch.setitem(sys.modules, "boardex_runner", None)
    assert doctor.expected_key_vars({}) == list(doctor.PROVIDER_KEY_ENV)
    assert doctor.check_provider_key({}).status == "warn"


def test_the_derivation_is_the_runners_own_not_a_second_opinion() -> None:
    """Pinned against credentials.py directly: if the store's rule changes,
    doctor changes with it instead of drifting."""
    credentials = pytest.importorskip("boardex_runner.credentials")
    models = ["openrouter/anthropic/claude-sonnet-4.6", "gemini/gemini-2.5-pro"]
    expected = [
        credentials.env_var_for(provider)
        for provider in credentials.providers_from_models(models)
    ]
    assert doctor.expected_key_vars({"AGENT_MODELS": ", ".join(models)}) == expected


def test_every_non_ok_check_carries_a_fix() -> None:
    for name in (
        "python",
        "pyocd",
        "sigrok-cli",
        "arm-none-eabi-gcc",
        "usb-access (linux)",
        "provider-key",
        "embedded-ui",
        "contract-schema",
    ):
        check = CheckResult(name, "missing", "not found", hint="fallback hint")
        for system in ("Linux", "Darwin", "Windows"):
            assert doctor.fix_command(check, system), f"{name} on {system} has no fix"


def test_pyocd_fix_names_the_bench_when_pyocd_itself_is_present() -> None:
    """An installed pyOCD with no probe plugged in is not a pip problem."""
    installed = CheckResult("pyocd", "warn", "pyOCD 0.45.1 present, no debug probe connected")
    assert "pip install" not in doctor.fix_command(installed, "Linux")
    assert "probe" in doctor.fix_command(installed, "Linux")

    absent = CheckResult("pyocd", "missing", "pyOCD is not importable")
    assert doctor.fix_command(absent, "Linux").startswith("pip install")


def test_an_ok_check_has_no_fix_line() -> None:
    check = CheckResult("sigrok-cli", "ok", "sigrok-cli 0.7.2")
    assert doctor.fix_command(check, "Linux") == ""
    assert "fix:" not in doctor.format_report([check])


def test_linux_usb_fix_is_a_paste_ready_udev_line() -> None:
    check = CheckResult("usb-access (linux)", "warn", "no bench udev rules detected")
    fix = doctor.fix_command(check, "Linux")
    assert fix.startswith("sudo cp ")
    assert "49-boardex-probes.rules" in fix
    assert "/etc/udev/rules.d/" in fix
    assert "udevadm control --reload" in fix and "udevadm trigger" in fix


def test_embedded_ui_check_reports_the_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    missing = tmp_path / "nothing"
    monkeypatch.setattr(doctor, "ui_bundle_dir", lambda: None)
    assert doctor.check_embedded_ui().status == "missing"

    bundle = tmp_path / "ui"
    (bundle / "assets").mkdir(parents=True)
    (bundle / "index.html").write_text("<html></html>", encoding="utf-8")
    (bundle / "assets" / "app.js").write_text("//", encoding="utf-8")
    monkeypatch.setattr(doctor, "ui_bundle_dir", lambda: bundle)
    found = doctor.check_embedded_ui()
    assert found.status == "ok" and "2 files" in found.detail
    assert not missing.exists()


def test_doctor_exits_zero_even_with_missing_components(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        doctor,
        "run_checks",
        lambda: [
            CheckResult("python", "ok", "Python 3.12.3"),
            CheckResult("sigrok-cli", "missing", "not on PATH"),
            CheckResult("provider-key", "warn", "no key"),
        ],
    )
    assert doctor.main() == 0
    report = capsys.readouterr().out
    assert "MISSING" in report and "1 ok · 1 warning(s) · 1 missing" in report
    assert "Advisory only" in report


def test_contract_schema_check_reports_what_the_runner_needs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(doctor, "contract_schema_dir", lambda: None)
    missing = doctor.check_contract_schemas()
    assert missing.status == "missing"
    assert "validates" in missing.detail

    monkeypatch.setattr(doctor, "contract_schema_dir", lambda: tmp_path)
    assert doctor.check_contract_schemas().status == "ok"


def test_run_checks_covers_the_documented_set() -> None:
    names = [check.name for check in doctor.run_checks()]
    assert names[:4] == ["python", "pyocd", "sigrok-cli", "arm-none-eabi-gcc"]
    assert any(name.startswith("usb-access") for name in names)
    assert {"provider-key", "embedded-ui", "contract-schema"} <= set(names)
