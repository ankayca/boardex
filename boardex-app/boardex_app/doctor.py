"""``boardex doctor`` — is this machine ready for a bench run?

The host checks themselves are boardex-core's (``boardex_core.doctor``, the
existing ``boardex-doctor`` script): Python floor, pyOCD, sigrok-cli, the Arm
toolchain, and per-OS USB access. This module adds the two things only the
installed app can answer — is a provider API key in the environment, and did
this install actually get a UI bundled — and turns every non-ok result into a
**command you can paste**, resolved for the OS you are on.

Advisory by contract: ``boardex doctor`` exits 0 even with missing components.
Nothing here blocks ``boardex up`` — the UI loads, the demo replays, and a run
against real hardware is the only thing a missing tool actually stops.
"""

from __future__ import annotations

import os
import platform
from collections.abc import Mapping

from boardex_core.doctor import (
    CheckResult,
    check_arm_toolchain,
    check_os_specific,
    check_pyocd,
    check_python,
    check_sigrok_cli,
)

from . import __version__
from .ui_assets import contract_schema_dir, udev_rules_path, ui_bundle_dir

# Provider-standard env vars, read by LiteLLM at call time (never stored by
# Boardex). The runner's default model is an OpenRouter one, so that key leads.
PROVIDER_KEY_ENV = (
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "AZURE_API_KEY",
)

_STATUS_MARK = {"ok": "ok     ", "warn": "warn   ", "missing": "MISSING"}


def check_provider_key(environ: Mapping[str, str] | None = None) -> CheckResult:
    """An agent run needs a model provider key; everything else does not."""
    env = os.environ if environ is None else environ
    present = [name for name in PROVIDER_KEY_ENV if (env.get(name) or "").strip()]
    if present:
        return CheckResult("provider-key", "ok", f"{', '.join(present)} set in the environment")
    return CheckResult(
        "provider-key",
        "warn",
        "no model provider API key in the environment — `boardex up` still "
        "runs (UI, demo, bench checks); an agent run needs one",
        hint="export a provider key before starting an agent run",
    )


def check_embedded_ui() -> CheckResult:
    ui = ui_bundle_dir()
    if ui is None:
        return CheckResult(
            "embedded-ui",
            "missing",
            "this install carries no UI bundle",
            hint="reinstall boardex (its wheel bundles the built UI)",
        )
    files = sum(1 for path in ui.rglob("*") if path.is_file())
    return CheckResult("embedded-ui", "ok", f"{files} files at {ui}")


def check_contract_schemas() -> CheckResult:
    """Without these the runner cannot emit a single event (it validates first)."""
    schemas = contract_schema_dir()
    if schemas is None:
        return CheckResult(
            "contract-schema",
            "missing",
            "this install carries no contract schemas — the runner validates "
            "every event it emits against them",
            hint="reinstall boardex, or set BOARDEX_CONTRACT_SCHEMA_DIR",
        )
    return CheckResult("contract-schema", "ok", str(schemas))


def fix_command(check: CheckResult, system: str | None = None) -> str:
    """The paste-ready fix for a non-ok check ("" when there is nothing to run)."""
    if check.ok:
        return ""
    host = platform.system() if system is None else system

    if check.name == "python":
        return "install Python >= 3.10 (python.org/downloads, pyenv, or your package manager)"
    if check.name == "pyocd":
        if check.status == "missing":
            return 'pip install "boardex-target"    # pulls pyOCD'
        # pyOCD is installed; the warning is about the bench, not the package —
        # either no probe is plugged in or USB enumeration could not read it.
        return check.hint or "connect a debug probe over USB (needed only to flash/debug)"
    if check.name == "sigrok-cli":
        if host == "Linux":
            return "sudo apt install sigrok-cli    # Kingst LA2016 needs a git-master build"
        if host == "Darwin":
            return "brew install sigrok-cli"
        return "install sigrok-cli from https://sigrok.org/wiki/Downloads"
    if check.name == "arm-none-eabi-gcc":
        if host == "Linux":
            return "sudo apt install gcc-arm-none-eabi"
        if host == "Darwin":
            return "brew install --cask gcc-arm-embedded"
        return "install the Arm GNU Toolchain and add its bin/ to PATH"
    if check.name.startswith("usb-access"):
        if host == "Linux":
            rules = udev_rules_path()
            source = str(rules) if rules is not None else (
                "servers/boardex-target/contrib/udev/49-boardex-probes.rules"
            )
            return (
                f"sudo cp {source} /etc/udev/rules.d/ && "
                "sudo udevadm control --reload && sudo udevadm trigger"
            )
        if host == "Windows":
            return (
                "install the ST-Link driver package (ST-Link probes) or bind WinUSB "
                "with Zadig (CMSIS-DAP, sigrok devices)"
            )
        return check.hint
    if check.name == "provider-key":
        return "export OPENROUTER_API_KEY=...    # or ANTHROPIC_API_KEY / OPENAI_API_KEY"
    if check.name in ("embedded-ui", "contract-schema"):
        return "pip install --force-reinstall boardex"
    return check.hint


def run_checks() -> list[CheckResult]:
    return [
        check_python(),
        check_pyocd(),
        check_sigrok_cli(),
        check_arm_toolchain(),
        check_os_specific(),
        check_provider_key(),
        check_embedded_ui(),
        check_contract_schemas(),
    ]


def format_report(checks: list[CheckResult], system: str | None = None) -> str:
    host = platform.system() if system is None else system
    lines = [
        f"boardex doctor — boardex {__version__} on {host} "
        f"{platform.release()} ({platform.machine()})",
        "",
    ]
    for check in checks:
        lines.append(f"  [{_STATUS_MARK[check.status]}] {check.name}: {check.detail}")
        fix = fix_command(check, host)
        if fix:
            lines.append(f"              fix: {fix}")
    counts = {status: sum(1 for c in checks if c.status == status) for status in _STATUS_MARK}
    lines += [
        "",
        f"  {counts['ok']} ok · {counts['warn']} warning(s) · {counts['missing']} missing",
        "  Advisory only — nothing here blocks `boardex up`.",
    ]
    return "\n".join(lines)


def main() -> int:
    """Always 0: doctor reports, it does not gate."""
    print(format_report(run_checks()))
    return 0
