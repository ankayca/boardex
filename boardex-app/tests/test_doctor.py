"""`boardex doctor`: what it reports, and that it never blocks."""

from __future__ import annotations

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

    seeded = doctor.check_provider_key({"ANTHROPIC_API_KEY": "sk-ant-test"})
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


def test_the_key_check_falls_back_to_the_fixed_list_without_agent_models() -> None:
    """Unset AGENT_MODELS: the runner would use its default model, so naming one
    variable would over-claim — accept any of the known provider keys."""
    assert doctor.expected_key_vars({}) == list(doctor.PROVIDER_KEY_ENV)
    # A bare model string derives no provider (the store says the same), so the
    # fixed list stands rather than a guess.
    assert doctor.expected_key_vars({"AGENT_MODELS": "some-local-model"}) == list(
        doctor.PROVIDER_KEY_ENV
    )
    assert doctor.check_provider_key({"OPENAI_API_KEY": "sk-x"}).status == "ok"


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
