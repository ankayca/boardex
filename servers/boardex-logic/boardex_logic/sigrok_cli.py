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

from boardex_core import BackendUnavailableError, OperationFailedError

#: Name of the CLI binary we drive. Overridable for tests via ``BINARY``.
BINARY = "sigrok-cli"

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
    args += ["-A", annotation or protocol]
    return run(args, timeout_s=timeout_s)
