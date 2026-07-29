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

# Fallback list, used only when this install cannot say which provider THIS
# runner would actually use (no AGENT_MODELS set, or no runner importable).
# Provider-standard names, read by LiteLLM at call time, never stored by Boardex.
PROVIDER_KEY_ENV = (
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "AZURE_API_KEY",
)


def expected_key_vars(environ: Mapping[str, str] | None = None) -> list[str]:
    """The env vars that matter for THIS runner, derived as the store derives them.

    A doctor that looks for a fixed list lies in both directions on a runner
    pointed elsewhere: with ``AGENT_MODELS=anthropic/...`` and only
    ``OPENROUTER_API_KEY`` exported it reports a key the agent will never read,
    and it names the wrong variable in the fix. So the derivation is the
    runner's own — ``credentials.providers_from_models`` + ``env_var_for``, the
    same two functions the store seeds itself with.

    An UNSET ``AGENT_MODELS`` is derivable too, and precisely: the runner then
    advertises exactly ``DEFAULT_MODEL``, so exactly one provider's key can ever
    be read, and naming it is the same claim ``/health`` makes. The fallback
    below mirrors ``credentials._models_from_env`` — same constant, same rule
    that the default applies to an ABSENT variable and not to an empty one —
    reproduced here rather than called because the store reads ``os.environ``
    directly and this has to answer for an environment handed to it.

    The fixed list survives only for what genuinely cannot be derived: a
    boardex-runner that will not import (``boardex doctor`` has to run in a
    half-broken install — that is when it is needed most) and a model string
    with no provider prefix, where the store says "no provider" too.
    """
    env = os.environ if environ is None else environ
    try:
        from boardex_runner import credentials
    except ImportError:
        return list(PROVIDER_KEY_ENV)
    raw = env.get("AGENT_MODELS", credentials.DEFAULT_MODEL)
    models = [model.strip() for model in raw.split(",") if model.strip()]
    providers = credentials.providers_from_models(models)
    if not providers:
        return list(PROVIDER_KEY_ENV)
    return [credentials.env_var_for(provider) for provider in providers]


_STATUS_MARK = {"ok": "ok     ", "warn": "warn   ", "missing": "MISSING"}


def check_provider_key(environ: Mapping[str, str] | None = None) -> CheckResult:
    """Whether a provider key is exported — the runner's *fallback* path.

    Since the runner's credential store landed, the dashboard is the primary
    way to set a key (Settings → Model provider, stored runner-side for the
    session) and the environment is the fallback that boots pre-configured. So
    an absent variable is not "you must open a shell": it is "no key yet, set
    one either way", and doctor can only see the environment half from here.
    """
    env = os.environ if environ is None else environ
    expected = expected_key_vars(env)
    present = [name for name in expected if (env.get(name) or "").strip()]
    if present:
        return CheckResult(
            "provider-key",
            "ok",
            f"{', '.join(present)} set in the environment (the runner boots configured)",
        )
    return CheckResult(
        "provider-key",
        "warn",
        f"no provider key exported ({' / '.join(expected)}) — `boardex up` still "
        "runs (UI, demo, bench checks); an agent run needs one, set in "
        "Settings → Model provider or here",
        # The variable named here is the one THIS runner would read, not a guess.
        hint=f"export {expected[0]}=...",
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
        # Two real paths since the runner's credential store landed; the
        # dashboard one needs no shell at all, so it leads. The export half
        # comes from the check's own hint, so it names the variable this
        # runner's advertised model would actually read.
        return (
            "`boardex up`, then Settings → Model provider (no shell needed) — "
            f"or {check.hint or 'export OPENROUTER_API_KEY=...'} before launch"
        )
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
