"""Generic, framework-neutral firmware builder.

Building firmware is a *host-side* operation: it runs a project's own build
command in a directory and captures the result. It is deliberately independent
of any debug probe or vendor SDK (a J-Link adapter has no business knowing how
to run ``make``), so it lives here as a plain function rather than on the
``TargetController`` interface.

The builder is a DUMB EXECUTOR (see docs/ARCHITECTURE.md): it runs the command,
turns the exit code into a ``Verdict`` (0 -> pass, non-zero -> fail), scrapes
compiler diagnostics into structured lists, and locates the built artifact. It
does not judge whether the firmware is *correct* -- that's the agent's job. A
thin framework-aware layer (e.g. Zephyr/twister) can be added on top later to
parse test results; the generic core comes first.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any

from boardex_core import OperationResult

# gcc/clang-style diagnostics, e.g. "main.c:42:5: error: 'x' undeclared".
# Framework-neutral because make/cmake/PlatformIO all shell out to the compiler.
_DIAGNOSTIC_RE = re.compile(
    r"^(?P<file>[^\s:][^:]*):(?P<line>\d+):(?:(?P<col>\d+):)?\s*"
    r"(?P<severity>error|warning|fatal error):\s*(?P<message>.*)$"
)

# Firmware image extensions, most-preferred first (agents flash the .elf).
_ARTIFACT_EXTS = (".elf", ".hex", ".bin", ".uf2")

# How a build system is recognised and, absent an explicit command, driven.
# Order matters: the first marker present in the project wins.
_BUILD_SYSTEMS: list[tuple[str, str, list[str]]] = [
    ("platformio.ini", "platformio", ["pio", "run"]),
    ("CMakeLists.txt", "cmake", ["cmake", "--build", "build"]),
    ("Makefile", "make", ["make"]),
    ("makefile", "make", ["make"]),
    ("meson.build", "meson", ["meson", "compile", "-C", "build"]),
]


def _detect_build_system(project: Path) -> tuple[str, list[str]] | None:
    """Return (system_name, default_command) inferred from files present."""
    for marker, name, command in _BUILD_SYSTEMS:
        if (project / marker).exists():
            return name, command
    return None


def _parse_diagnostics(text: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split compiler output into structured error/warning records."""
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    for line in text.splitlines():
        match = _DIAGNOSTIC_RE.match(line.strip())
        if not match:
            continue
        record = {
            "file": match["file"],
            "line": int(match["line"]),
            "column": int(match["col"]) if match["col"] else None,
            "message": match["message"],
            "raw": line.strip(),
        }
        if match["severity"] == "warning":
            warnings.append(record)
        else:
            errors.append(record)
    return errors, warnings


def _find_artifact(
    project: Path, artifact: str | None
) -> tuple[str | None, list[str]]:
    """Locate the build output.

    If ``artifact`` is given it is treated as a path or glob (relative paths are
    resolved against the project). Otherwise we pick the most-recently-modified
    firmware image in the project tree, preferring ``.elf``. We deliberately do
    *not* require the file to be newer than this build: incremental builds often
    rebuild nothing, and the newest image is still the correct artifact to flash.
    Returns (best_match, all_candidates).
    """
    if artifact:
        pattern = Path(artifact)
        if pattern.is_absolute():
            root = Path(pattern.anchor)
            matches = [str(p) for p in root.glob(str(pattern.relative_to(root)))]
        else:
            matches = [str(p) for p in project.glob(artifact)]
        matches.sort(key=os.path.getmtime, reverse=True)
        return (matches[0] if matches else None), matches

    # Auto-discover: newest image overall, ties broken by preferred extension.
    candidates: list[tuple[str, float, int]] = []
    for path in project.rglob("*"):
        if not path.is_file() or path.suffix not in _ARTIFACT_EXTS:
            continue
        candidates.append(
            (str(path), path.stat().st_mtime, _ARTIFACT_EXTS.index(path.suffix))
        )
    candidates.sort(key=lambda c: (-c[1], c[2]))
    ordered = [c[0] for c in candidates]
    return (ordered[0] if ordered else None), ordered


def build_firmware(
    project_dir: str,
    command: str | None = None,
    *,
    artifact: str | None = None,
    env: dict[str, str] | None = None,
    clean: bool = False,
    timeout_s: float = 600.0,
) -> OperationResult:
    """Run a firmware project's build command and report the result.

    Args:
        project_dir: Absolute path to the firmware project (external to Boardex).
        command: Build command to run (as a shell string). If omitted, it is
            auto-detected from project files (Makefile -> make, CMakeLists.txt ->
            cmake, platformio.ini -> pio run, ...).
        artifact: Optional path or glob (relative to the project) pinning the
            build output. If omitted, the newest .elf/.hex/.bin/.uf2 produced by
            the build is reported.
        env: Extra environment variables merged over the current environment
            (e.g. to put a cross-toolchain on PATH).
        clean: Prepend the detected build system's clean step when possible.
        timeout_s: Kill the build if it exceeds this many seconds.

    Verdict: ``pass`` if the build command exits 0, ``fail`` if it exits
    non-zero (compile/link errors), ``error`` if the build could not be started
    (missing directory, unknown build system, command not found, timeout).
    """
    project = Path(project_dir)
    if not project.is_dir():
        return OperationResult.errored(
            f"Project directory does not exist: {project_dir}"
        )

    system: str | None = None
    if command is None:
        detected = _detect_build_system(project)
        if detected is None:
            return OperationResult.errored(
                "Could not detect a build system in "
                f"{project_dir} (looked for Makefile, CMakeLists.txt, "
                "platformio.ini, meson.build). Pass an explicit `command`.",
            )
        system, argv = detected
        run_command = " ".join(shlex.quote(a) for a in argv)
    else:
        run_command = command

    # A make/cmake clean is cheap and framework-known; other systems are left to
    # the caller's explicit command (they vary too much to guess safely).
    if clean:
        if system == "make":
            run_command = f"make clean; {run_command}"
        elif system == "cmake":
            run_command = f"cmake --build build --target clean; {run_command}"

    run_env = {**os.environ, **(env or {})}
    started = time.monotonic()
    build_start_wall = time.time()

    try:
        # shell=True so compound/toolchain-prefixed commands and clean steps work
        # uniformly regardless of build system.
        completed = subprocess.run(
            run_command,
            cwd=str(project),
            env=run_env,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return OperationResult.errored(
            f"Build timed out after {timeout_s:.0f}s.",
            command=run_command,
            timeout_s=timeout_s,
        )

    duration = round(time.monotonic() - started, 3)
    stdout, stderr = completed.stdout or "", completed.stderr or ""
    errors, warnings = _parse_diagnostics(stdout + "\n" + stderr)

    artifact_path, artifact_candidates = _find_artifact(project, artifact)
    # Whether this build actually (re)produced the image, vs. reporting a
    # pre-existing one from an up-to-date incremental build.
    artifact_rebuilt = (
        artifact_path is not None
        and os.path.getmtime(artifact_path) + 0.001 >= build_start_wall
    )

    data: dict[str, Any] = {
        "command": run_command,
        "build_system": system,
        "returncode": completed.returncode,
        "artifact_path": artifact_path,
        "artifact_rebuilt": artifact_rebuilt,
        "artifact_candidates": artifact_candidates,
        "errors": errors,
        "warnings": warnings,
        "stdout": stdout,
        "stderr": stderr,
    }
    warning_notes = [f"{w['raw']}" for w in warnings[:20]]

    if completed.returncode != 0:
        summary = (
            f"Build failed (exit {completed.returncode})"
            + (f": {len(errors)} error(s), first: {errors[0]['raw']}"
               if errors else "; no gcc-style diagnostics parsed, see stderr.")
        )
        result = OperationResult.failed(summary, **data)
        result.warnings = warning_notes
        result.duration_s = duration
        return result

    if artifact_path is None:
        result = OperationResult.passed(
            "Build command succeeded (exit 0) but no firmware artifact "
            "(.elf/.hex/.bin) was found; pass `artifact` to pin the output path.",
            **data,
        )
    else:
        result = OperationResult.passed(
            f"Build succeeded: {artifact_path}", **data
        )
    result.warnings = warning_notes
    result.duration_s = duration
    return result
