"""boardex-doctor checks — all seams stubbed, no USB, no system binaries."""

from __future__ import annotations

import subprocess
from pathlib import Path

from boardex_core import doctor


class TestPython:
    def test_current_interpreter_passes(self):
        assert doctor.check_python().ok

    def test_too_old_is_fatal(self):
        result = doctor.check_python(version_info=(3, 9, 18))
        assert result.status == "missing"
        report = doctor.DoctorReport(checks=[result])
        assert report.failed


class TestPyocd:
    def test_missing_import(self):
        def no_module(name):
            raise ImportError(name)

        result = doctor.check_pyocd(import_module=no_module)
        assert result.status == "missing"
        assert "pip install" in result.hint

    def test_import_ok_no_probes_is_warn_not_failure(self):
        fake_pyocd = type("m", (), {"__version__": "0.36.0"})
        result = doctor.check_pyocd(
            import_module=lambda name: fake_pyocd, enumerate_probes=lambda: []
        )
        assert result.status == "warn"
        assert "no debug probe" in result.detail

    def test_probes_found(self):
        fake_pyocd = type("m", (), {"__version__": "0.36.0"})
        result = doctor.check_pyocd(
            import_module=lambda name: fake_pyocd,
            enumerate_probes=lambda: [object(), object()],
        )
        assert result.ok
        assert "2 probe(s)" in result.detail

    def test_enumeration_crash_never_raises(self):
        fake_pyocd = type("m", (), {"__version__": "0.36.0"})

        def boom():
            raise RuntimeError("libusb exploded")

        result = doctor.check_pyocd(
            import_module=lambda name: fake_pyocd, enumerate_probes=boom
        )
        assert result.status == "warn"
        assert "libusb exploded" in result.detail


class TestSigrokCli:
    def test_missing_binary(self):
        result = doctor.check_sigrok_cli(which=lambda name: None)
        assert result.status == "missing"
        assert "kingst-la-bringup" in result.hint

    def test_version_reported(self):
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(
                argv, 0, stdout="sigrok-cli 0.8.0\n", stderr=""
            )

        result = doctor.check_sigrok_cli(
            which=lambda name: "/usr/bin/sigrok-cli", run=fake_run
        )
        assert result.ok
        assert "sigrok-cli 0.8.0" in result.detail


class TestArmToolchain:
    def test_missing(self):
        result = doctor.check_arm_toolchain(which=lambda name: None)
        assert result.status == "missing"

    def test_found(self):
        result = doctor.check_arm_toolchain(
            which=lambda name: "/opt/arm/bin/arm-none-eabi-gcc"
        )
        assert result.ok


class TestOsSpecific:
    def test_linux_without_rules_warns_with_install_hint(self, tmp_path: Path):
        result = doctor.check_os_specific(system="Linux", udev_dirs=[tmp_path])
        assert result.status == "warn"
        assert "contrib/udev" in result.hint

    def test_linux_with_boardex_rules_ok(self, tmp_path: Path):
        (tmp_path / "49-boardex-probes.rules").write_text("# rules\n")
        result = doctor.check_os_specific(system="Linux", udev_dirs=[tmp_path])
        assert result.ok

    def test_windows_flags_winusb(self):
        result = doctor.check_os_specific(system="Windows")
        assert result.status == "warn"
        assert "WinUSB" in result.detail

    def test_macos_ok(self):
        result = doctor.check_os_specific(system="Darwin")
        assert result.ok


def test_report_formats_every_check_and_exit_semantics():
    report = doctor.DoctorReport(
        checks=[
            doctor.CheckResult("python", "ok", "Python 3.12.1"),
            doctor.CheckResult("sigrok-cli", "missing", "not found", hint="install it"),
        ]
    )
    text = doctor.format_report(report)
    assert "python: Python 3.12.1" in text
    assert "MISSING" in text
    assert "hint: install it" in text
    # Missing bench tools are advisory, not fatal.
    assert not report.failed
