"""``boardex-doctor``: host-environment checker for the Boardex bench stack.

Boardex deliberately ships **no** kernel drivers or vendor blobs: debug probes
are reached through pyOCD/libusb (a pip install), logic analyzers through a
system ``sigrok-cli``, and firmware builds through whatever cross-toolchain is
on PATH. That keeps the packages OS-independent, but it moves the "is this
machine actually ready?" question to the user — this module answers it.

Every check is a plain function taking its OS/subprocess seams as injectable
parameters, so the suite stays hardware-free (repo invariant): tests stub
``which``, module import, and probe enumeration instead of touching USB.

Statuses:
- ``ok``      the component is present and usable
- ``warn``    present but degraded, or an OS-specific caveat applies
- ``missing`` not found; ``hint`` says how to get it
"""

from __future__ import annotations

import importlib
import platform
import shutil
import subprocess
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

_MIN_PYTHON = (3, 10)

# udev rule files (any of these) that grant non-root access to the bench USB
# devices on Linux. Boardex ships its own copy for probes under
# servers/boardex-target/contrib/udev/.
_UDEV_HINT_FILES = (
    "49-boardex-probes.rules",
    "50-cmsis-dap.rules",
    "60-libsigrok.rules",
    "99-Kingst.rules",
    "49-stlinkv2.rules",
    "49-stlinkv3.rules",
)


@dataclass
class CheckResult:
    name: str
    status: str  # "ok" | "warn" | "missing"
    detail: str
    hint: str = ""

    @property
    def ok(self) -> bool:
        return self.status == "ok"


@dataclass
class DoctorReport:
    checks: list[CheckResult] = field(default_factory=list)

    @property
    def failed(self) -> bool:
        """Only a too-old Python is fatal; absent bench tools are advisory."""
        return any(c.name == "python" and c.status == "missing" for c in self.checks)


def check_python(version_info: tuple[int, ...] = sys.version_info) -> CheckResult:
    version = ".".join(str(part) for part in version_info[:3])
    if tuple(version_info[:2]) < _MIN_PYTHON:
        return CheckResult(
            "python",
            "missing",
            f"Python {version} is below the supported floor",
            hint=f"install Python >= {'.'.join(map(str, _MIN_PYTHON))}",
        )
    return CheckResult("python", "ok", f"Python {version}")


def check_pyocd(
    import_module: Callable[[str], object] = importlib.import_module,
    enumerate_probes: Callable[[], list[object]] | None = None,
) -> CheckResult:
    """pyOCD importability and (best-effort) probe enumeration.

    Enumeration is a USB scan, not a connection — safe to run, but entirely
    optional: "no probe plugged in right now" is a warn, not a failure.
    """
    try:
        module = import_module("pyocd")
    except ImportError:
        return CheckResult(
            "pyocd",
            "missing",
            "pyOCD is not importable in this environment",
            hint='pip install "boardex-target" (pulls pyocd) or pip install pyocd',
        )
    version = getattr(module, "__version__", "unknown")

    if enumerate_probes is None:
        def enumerate_probes() -> list[object]:
            from pyocd.probe.aggregator import DebugProbeAggregator

            return list(DebugProbeAggregator.get_all_connected_probes())

    try:
        probes = enumerate_probes()
    except Exception as err:  # USB stack errors vary by OS; never crash doctor
        return CheckResult(
            "pyocd",
            "warn",
            f"pyOCD {version} imported but probe enumeration failed: {err}",
            hint="check libusb and USB permissions (see doctor's OS checks)",
        )
    if not probes:
        return CheckResult(
            "pyocd",
            "warn",
            f"pyOCD {version} present, no debug probe currently connected",
        )
    return CheckResult(
        "pyocd", "ok", f"pyOCD {version}, {len(probes)} probe(s) connected"
    )


def check_sigrok_cli(
    which: Callable[[str], str | None] = shutil.which,
    run: Callable[..., "subprocess.CompletedProcess[str]"] = subprocess.run,
) -> CheckResult:
    path = which("sigrok-cli")
    if path is None:
        return CheckResult(
            "sigrok-cli",
            "missing",
            "sigrok-cli not found on PATH (boardex-logic needs it)",
            hint="install sigrok-cli >= 0.7 (Kingst LA needs a git-master build; "
            "see docs/kingst-la-bringup.md)",
        )
    try:
        completed = run(
            [path, "--version"], capture_output=True, text=True, timeout=10
        )
        first_line = (completed.stdout or "").splitlines()[0] if completed.stdout else ""
    except Exception as err:
        return CheckResult(
            "sigrok-cli", "warn", f"{path} found but --version failed: {err}"
        )
    return CheckResult("sigrok-cli", "ok", f"{first_line or path} ({path})")


def check_arm_toolchain(
    which: Callable[[str], str | None] = shutil.which,
) -> CheckResult:
    path = which("arm-none-eabi-gcc")
    if path is None:
        return CheckResult(
            "arm-none-eabi-gcc",
            "missing",
            "no Arm cross-toolchain on PATH (firmware builds will fail)",
            hint="install the Arm GNU Toolchain and put its bin/ on PATH "
            "(examples/firmware/*/Makefile accepts CROSS=... too)",
        )
    return CheckResult("arm-none-eabi-gcc", "ok", path)


def check_os_specific(
    system: str = platform.system(),
    udev_dirs: Iterable[Path] = (Path("/etc/udev/rules.d"), Path("/usr/lib/udev/rules.d")),
) -> CheckResult:
    """Per-OS USB access caveats — the 'drivers' question, answered per platform."""
    if system == "Linux":
        found = [
            str(directory / name)
            for directory in udev_dirs
            if directory.is_dir()
            for name in _UDEV_HINT_FILES
            if (directory / name).exists()
        ]
        if not found:
            return CheckResult(
                "usb-access (linux)",
                "warn",
                "no bench udev rules detected — probes/analyzers may need root",
                hint="install servers/boardex-target/contrib/udev/"
                "49-boardex-probes.rules and libsigrok's 60-libsigrok.rules, "
                "then `udevadm control --reload`; see docs/SUPPORT_MATRIX.md",
            )
        return CheckResult(
            "usb-access (linux)", "ok", f"udev rules present: {', '.join(found)}"
        )
    if system == "Windows":
        return CheckResult(
            "usb-access (windows)",
            "warn",
            "probes need a WinUSB/libusb driver bound to the interface",
            hint="ST-Link: install the ST driver package; CMSIS-DAP: WinUSB via "
            "Zadig if enumeration fails; sigrok devices: Zadig/WinUSB",
        )
    if system == "Darwin":
        return CheckResult(
            "usb-access (macos)",
            "ok",
            "no kernel driver needed; pyOCD/sigrok use libusb directly",
            hint="if enumeration fails: `brew install libusb`",
        )
    return CheckResult("usb-access", "warn", f"unrecognised OS: {system}")


def run_doctor() -> DoctorReport:
    return DoctorReport(
        checks=[
            check_python(),
            check_pyocd(),
            check_sigrok_cli(),
            check_arm_toolchain(),
            check_os_specific(),
        ]
    )


_STATUS_MARK = {"ok": "ok     ", "warn": "warn   ", "missing": "MISSING"}


def format_report(report: DoctorReport) -> str:
    lines = [
        f"boardex-doctor — {platform.system()} {platform.release()} "
        f"({platform.machine()})"
    ]
    for check in report.checks:
        lines.append(f"  [{_STATUS_MARK[check.status]}] {check.name}: {check.detail}")
        if check.hint:
            lines.append(f"            hint: {check.hint}")
    return "\n".join(lines)


def main() -> int:
    report = run_doctor()
    print(format_report(report))
    return 1 if report.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
