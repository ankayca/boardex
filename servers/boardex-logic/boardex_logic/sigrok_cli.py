"""Thin wrapper around the ``sigrok-cli`` binary.

This is the only module (together with the adapter) that knows sigrok exists.
It shells out to ``sigrok-cli`` and returns raw stdout; all parsing of that
output into structured, agent-friendly data lives in the pure ``parse`` module
so it can be unit-tested without the binary or any hardware.

Why subprocess instead of libsigrok's Python bindings: it mirrors how
``boardex-target`` treats pyOCD as an isolated executor, keeps a wedged USB
device from taking down the MCP server process, and avoids a fragile native
binding build. The tradeoff is coarser data (we get whatever ``sigrok-cli``
prints), which is exactly the granularity the agent-facing tools want anyway.
"""

from __future__ import annotations

import shutil
import subprocess
import threading
from collections import deque
from typing import Callable

from boardex_core import BackendUnavailableError, OperationFailedError

#: Name of the CLI binary we drive. Overridable for tests via ``BINARY``.
BINARY = "sigrok-cli"

#: Substrings sigrok-cli logs (at ``-l 5``) the instant a device is physically
#: sampling. On streaming, memory-less analyzers (Kingst LA1010, FX2 clones)
#: acquisition begins immediately — there is no hardware trigger to wait on — so
#: the first receive callback / frame-begin is the only trustworthy "the window
#: is now open" signal. Matching either keeps this robust across sigrok versions.
ACQUISITION_STARTED_MARKERS: tuple[str, ...] = (
    "First receive callback in stream mode",
    "Received SR_DF_FRAME_BEGIN",
)

#: Map Boardex's brand-neutral trigger edges to sigrok's single-char codes.
#: (see ``sigrok-cli(1)``: r=rising f=falling 0=low 1=high e=either)
TRIGGER_EDGES: dict[str, str] = {
    "rising": "r",
    "falling": "f",
    "high": "1",
    "low": "0",
    "either": "e",
}


def sigrok_available() -> bool:
    """Whether ``sigrok-cli`` is installed and on PATH."""
    return shutil.which(BINARY) is not None


def _binary() -> str:
    path = shutil.which(BINARY)
    if path is None:
        raise BackendUnavailableError(
            f"'{BINARY}' not found on PATH. Install sigrok "
            "(libsigrok + sigrok-cli) to use logic analyzers."
        )
    return path


def run(args: list[str], *, timeout_s: float = 30.0) -> str:
    """Run ``sigrok-cli`` with ``args`` and return its stdout.

    Raises ``OperationFailedError`` on non-zero exit or timeout, surfacing
    sigrok's stderr so the agent gets an actionable message (missing firmware,
    device busy, unknown driver, ...).
    """
    cmd = [_binary(), *args]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired as exc:
        raise OperationFailedError(
            f"sigrok-cli timed out after {timeout_s:g}s: {' '.join(args)}"
        ) from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise OperationFailedError(
            f"sigrok-cli failed (exit {proc.returncode}): {detail or 'no output'}"
        )
    return proc.stdout


def run_coordinated(
    args: list[str],
    *,
    on_armed: Callable[[], None],
    arm_markers: tuple[str, ...] = ACQUISITION_STARTED_MARKERS,
    arm_timeout_s: float = 10.0,
    timeout_s: float = 60.0,
) -> tuple[str, bool]:
    """Run ``sigrok-cli`` and fire ``on_armed`` when sampling actually starts.

    Streams stderr on a background thread, watching for an
    ``arm_markers`` line; the moment one appears (acquisition is physically
    live) ``on_armed`` is invoked from *this* thread while the stderr/stdout
    drains keep running, so the callback cannot back-pressure sigrok's pipes and
    stall the capture. Returns ``(stdout, armed_via_marker)``.

    If no marker is seen within ``arm_timeout_s`` the callback is still invoked
    once (as a best-effort fallback) so a coordinator never leaves a target
    halted, and ``armed_via_marker`` is ``False``.

    Raises ``OperationFailedError`` on non-zero exit or timeout, mirroring
    ``run`` so callers get the same actionable stderr tail.
    """
    cmd = [_binary(), *args]
    armed = threading.Event()
    stderr_tail: deque[str] = deque(maxlen=50)
    stdout_chunks: list[str] = []

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    def drain_stdout() -> None:
        assert proc.stdout is not None
        stdout_chunks.append(proc.stdout.read())

    def drain_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_tail.append(line.rstrip("\n"))
            if not armed.is_set() and any(m in line for m in arm_markers):
                armed.set()

    t_out = threading.Thread(target=drain_stdout, daemon=True)
    t_err = threading.Thread(target=drain_stderr, daemon=True)
    t_out.start()
    t_err.start()

    armed_via_marker = armed.wait(timeout=arm_timeout_s)
    try:
        on_armed()
    finally:
        # A resume that partially ran must not leak the sigrok subprocess: fall
        # through to reap it regardless of what the callback did.
        try:
            proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired as exc:
            proc.kill()
            proc.wait()
            t_out.join(timeout=5)
            t_err.join(timeout=5)
            raise OperationFailedError(
                f"sigrok-cli timed out after {timeout_s:g}s: {' '.join(args)}"
            ) from exc

    t_out.join(timeout=5)
    t_err.join(timeout=5)

    if proc.returncode != 0:
        detail = "\n".join(stderr_tail).strip()
        raise OperationFailedError(
            f"sigrok-cli failed (exit {proc.returncode}): {detail or 'no output'}"
        )
    return "".join(stdout_chunks), armed_via_marker


def version() -> str:
    """Return the ``sigrok-cli --version`` banner (first line)."""
    return run(["--version"], timeout_s=10).splitlines()[0].strip()


def scan_raw() -> str:
    """Raw output of ``sigrok-cli --scan`` (one device per line)."""
    return run(["--scan"], timeout_s=20)


def show_raw(device_spec: str) -> str:
    """Raw output of ``sigrok-cli -d <spec> --show`` (device capabilities)."""
    return run(["-d", device_spec, "--show"], timeout_s=20)


def capture_csv(
    device_spec: str,
    *,
    sample_rate_hz: int,
    num_samples: int,
    channels: list[str] | None = None,
    trigger: tuple[str, str] | None = None,
    timeout_s: float = 60.0,
) -> str:
    """Run one acquisition and return CSV (one row per sample).

    Args:
        device_spec: sigrok device string (e.g. ``kingst-la2016:conn=3.7``).
        sample_rate_hz: Requested sample rate in Hz.
        num_samples: Number of samples to acquire.
        channels: Channel names to enable/emit (e.g. ``["D0", "D1"]``); all if
            None.
        trigger: ``(channel_name, edge_code)`` to arm a hardware trigger, where
            ``edge_code`` is a sigrok trigger char from ``TRIGGER_EDGES``.
    """
    args = [
        "-d",
        device_spec,
        "--config",
        f"samplerate={sample_rate_hz}",
        "--samples",
        str(num_samples),
    ]
    if channels:
        args += ["--channels", ",".join(channels)]
    if trigger is not None:
        name, edge = trigger
        args += ["--triggers", f"{name}={edge}"]
    # label=channel -> real channel names in the header (default 'units' prints
    # "logic" for every column); dedup=false -> one row per sample so a sample
    # index maps to real time (the default collapses runs of identical samples).
    args += ["-O", "csv:label=channel:dedup=false"]
    return run(args, timeout_s=timeout_s)


def _decode_args(
    device_spec: str,
    *,
    sample_rate_hz: int,
    num_samples: int,
    protocol: str,
    channel_map: dict[str, str],
    options: dict[str, str] | None,
    annotation: str | None,
    channels: list[str] | None,
    trigger: tuple[str, str] | None,
) -> list[str]:
    pd = protocol
    for pin, name in channel_map.items():
        pd += f":{pin}={name}"
    for key, val in (options or {}).items():
        pd += f":{key}={val}"
    args = [
        "-d",
        device_spec,
        "--config",
        f"samplerate={sample_rate_hz}",
        "--samples",
        str(num_samples),
        "-P",
        pd,
    ]
    if channels:
        args += ["--channels", ",".join(channels)]
    if trigger is not None:
        name, edge = trigger
        args += ["--triggers", f"{name}={edge}"]
    # Sample ranges make protocol evidence physically measurable (for example,
    # each I2C bit span yields the observed SCL period).
    args += ["--protocol-decoder-samplenum", "-A", annotation or protocol]
    return args


def decode_raw(
    device_spec: str,
    *,
    sample_rate_hz: int,
    num_samples: int,
    protocol: str,
    channel_map: dict[str, str],
    options: dict[str, str] | None = None,
    annotation: str | None = None,
    channels: list[str] | None = None,
    trigger: tuple[str, str] | None = None,
    timeout_s: float = 60.0,
) -> str:
    """Capture and run a sigrok protocol decoder, returning annotation lines.

    ``protocol`` is a libsigrokdecode id (``i2c``, ``spi``, ``uart``, ...);
    ``channel_map`` binds decoder inputs to device channel *names*
    (e.g. ``{"scl": "CH0", "sda": "CH1"}``); ``options`` sets decoder options
    (e.g. ``{"baudrate": "115200"}``).
    """
    args = _decode_args(
        device_spec,
        sample_rate_hz=sample_rate_hz,
        num_samples=num_samples,
        protocol=protocol,
        channel_map=channel_map,
        options=options,
        annotation=annotation,
        channels=channels,
        trigger=trigger,
    )
    return run(args, timeout_s=timeout_s)


def decode_raw_coordinated(
    device_spec: str,
    *,
    on_armed: Callable[[], None],
    sample_rate_hz: int,
    num_samples: int,
    protocol: str,
    channel_map: dict[str, str],
    options: dict[str, str] | None = None,
    annotation: str | None = None,
    channels: list[str] | None = None,
    trigger: tuple[str, str] | None = None,
    arm_timeout_s: float = 10.0,
    timeout_s: float = 60.0,
) -> tuple[str, bool]:
    """Like ``decode_raw`` but fire ``on_armed`` when sampling actually starts.

    Adds ``-l 5`` so sigrok logs the acquisition-start markers this needs, then
    routes through :func:`run_coordinated`. Returns ``(stdout, armed_via_marker)``.
    """
    args = _decode_args(
        device_spec,
        sample_rate_hz=sample_rate_hz,
        num_samples=num_samples,
        protocol=protocol,
        channel_map=channel_map,
        options=options,
        annotation=annotation,
        channels=channels,
        trigger=trigger,
    )
    # -l 5 raises sigrok's log verbosity to stderr so the acquisition-start
    # markers are emitted; annotation output still goes to stdout untouched.
    args = ["-l", "5", *args]
    return run_coordinated(
        args,
        on_armed=on_armed,
        arm_timeout_s=arm_timeout_s,
        timeout_s=timeout_s,
    )
