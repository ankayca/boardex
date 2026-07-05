"""boardex-logic MCP server: the agent-facing facade for logic analyzers.

Layer 4 of the Boardex architecture (see docs/ARCHITECTURE.md). Tools here are
coarse, intent-level ("capture these channels", "decode this bus") and always
return a structured ``OperationResult`` dict so the agent's stimulate -> capture
-> verify loop can branch on a machine-readable verdict.

Tools never touch hardware directly: they go through the ``BackendRegistry`` to
whichever adapter owns the requested ``device_id``. Add a new analyzer backend by
registering another adapter below; no tool definitions change.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

from boardex_core import BackendRegistry, BoardexError, LogicAnalyzer, OperationResult
from mcp.server.fastmcp import FastMCP

from .adapters.sigrok_adapter import SigrokAdapter

log = logging.getLogger("boardex.logic")

mcp = FastMCP("boardex-logic")

# Registry of logic-analyzer backends. Register new drivers here and they
# immediately appear in list_analyzers() with no tool changes.
registry: BackendRegistry[LogicAnalyzer] = BackendRegistry()
registry.register("sigrok", SigrokAdapter)


def _guard(fn: Any) -> OperationResult:
    """Run an adapter call, converting expected failures into error results.

    Guarantees the agent always receives a valid ``OperationResult`` instead of a
    raised exception across the MCP wire.
    """
    try:
        return fn()
    except BoardexError as exc:
        log.warning("operation failed: %s", exc)
        return OperationResult.errored(str(exc))
    except Exception as exc:  # noqa: BLE001 - last-resort safety net
        log.exception("unexpected error")
        return OperationResult.errored(f"Unexpected error: {exc}")


@mcp.tool()
def list_analyzers() -> dict[str, Any]:
    """List every logic analyzer currently connected to the bench.

    Returns a result whose ``data.devices`` is a list of device descriptors. Use
    each device's ``device_id`` in the other tools. If ``data.backends`` is empty,
    the sigrok tooling isn't installed (or no analyzer is plugged in / powered).
    """
    devices = registry.scan()
    return OperationResult.passed(
        f"Found {len(devices)} logic analyzer(s).",
        devices=[d.to_dict() for d in devices],
        backends=registry.available_backends(),
    ).to_dict()


@mcp.tool()
def get_capabilities(device_id: str) -> dict[str, Any]:
    """Report an analyzer's limits so you can plan a valid capture.

    Returns ``data.channels`` (names), ``data.channel_count``,
    ``data.max_sample_rate_hz``, the full ``data.samplerates`` list, and the
    supported ``data.triggers``. Pure introspection; changes nothing.
    """
    return _guard(lambda: registry.resolve(device_id).capabilities(device_id)).to_dict()


@mcp.tool()
def capture(
    device_id: str,
    channels: list[int] | None = None,
    sample_rate_hz: int = 1_000_000,
    num_samples: int | None = None,
    duration_s: float | None = None,
    trigger_channel: int | None = None,
    trigger_edge: str = "rising",
) -> dict[str, Any]:
    """Capture one acquisition of digital samples from an analyzer.

    Args:
        device_id: Id from ``list_analyzers`` (e.g. "sigrok:kingst-la2016:conn=3.7").
        channels: Channel indices to record (e.g. [0, 1, 2]); None = all.
        sample_rate_hz: Requested sample rate in Hz; hardware rounds to a rate it
            supports (see ``get_capabilities`` for valid rates).
        num_samples: Number of samples to capture. Provide this or ``duration_s``
            (num_samples wins if both are given).
        duration_s: Capture length in seconds (converted to samples via the rate)
            when ``num_samples`` is not given.
        trigger_channel: Channel index to trigger on; None captures immediately.
        trigger_edge: One of "rising"/"falling"/"high"/"low"/"either".

    Branch on ``data.measurements`` — a per-channel summary you can act on
    without crunching the raw samples: ``active`` (did it toggle?), ``edges``,
    ``frequency_hz`` (estimated fundamental), ``duty_cycle`` (0..1), and
    ``min_pulse_width_s`` (surfaces glitches/runt pulses). ``data.transitions``
    holds the compact per-channel edge list ([sample_index, level], ...) for
    detail (clipped for size on very busy channels — counts stay exact in
    measurements). Also returns ``data.sample_rate_hz``, ``data.num_samples`` and
    ``data.duration_s``.
    """
    return _guard(
        lambda: registry.resolve(device_id).capture(
            device_id,
            channels=channels,
            sample_rate_hz=sample_rate_hz,
            num_samples=num_samples,
            duration_s=duration_s,
            trigger_channel=trigger_channel,
            trigger_edge=trigger_edge,
        )
    ).to_dict()


@mcp.tool()
def decode_bus(
    device_id: str,
    protocol: str,
    channel_map: dict[str, int],
    sample_rate_hz: int = 1_000_000,
    num_samples: int | None = None,
    duration_s: float | None = None,
    options: dict[str, str] | None = None,
    trigger_channel: int | None = None,
    trigger_edge: str = "rising",
) -> dict[str, Any]:
    """Capture a bus and decode it into transactions (I2C/SPI/UART/...).

    Turns raw edges into decoded traffic so you can check a bus against a
    datasheet instead of reading waveforms by hand.

    Args:
        device_id: Id from ``list_analyzers``.
        protocol: Decoder id (e.g. "i2c", "spi", "uart").
        channel_map: Decoder input -> channel index, e.g. {"scl": 0, "sda": 1}
            for I2C or {"rx": 0} for UART.
        sample_rate_hz: Sample rate for the capture (use >= ~4x the bus clock).
        num_samples / duration_s: Capture length (num_samples wins).
        options: Decoder options, e.g. {"baudrate": "115200"} for UART.
        trigger_channel: Channel index to trigger on; None captures immediately.
        trigger_edge: One of "rising"/"falling"/"high"/"low"/"either".

    Returns ``data.annotations`` — the decoded stream — and, for supported
    protocols, ``data.transactions`` (structured records) plus ``data.bus_state``
    (``idle_bus`` / ``activity_no_decode`` / ``decoded_ok``). Verdict is
    ``inconclusive`` if nothing decoded (wrong channel map, rate too low, or an
    idle bus).
    """
    return _guard(
        lambda: registry.resolve(device_id).decode(
            device_id,
            protocol,
            channel_map,
            sample_rate_hz=sample_rate_hz,
            num_samples=num_samples,
            duration_s=duration_s,
            options=options,
            trigger_channel=trigger_channel,
            trigger_edge=trigger_edge,
        )
    ).to_dict()


@mcp.tool()
def capture_during(
    device_id: str,
    protocol: str,
    channel_map: dict[str, int],
    sample_rate_hz: int = 4_000_000,
    duration_s: float = 0.1,
    trigger_channel: int | None = None,
    trigger_edge: str = "falling",
    options: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Trigger-armed bus capture for sporadic traffic (I2C/SPI/UART/...).

    Same as ``decode_bus`` but defaults to a short window and SCL-falling trigger
    for I2C. Coordinate with the target MCP: call ``reset_target`` on the MCU
    immediately before this tool so the capture covers the first post-reset bus
    activity.

    For I2C, when ``trigger_channel`` is omitted the ``scl`` entry from
    ``channel_map`` is used.
    """
    trig = trigger_channel
    if trig is None and protocol.lower() == "i2c" and "scl" in channel_map:
        trig = channel_map["scl"]
    return decode_bus(
        device_id,
        protocol,
        channel_map,
        sample_rate_hz=sample_rate_hz,
        duration_s=duration_s,
        options=options,
        trigger_channel=trig,
        trigger_edge=trigger_edge,
    )


def main() -> None:
    """Console entry point: run the server over stdio (how MCP clients spawn it).

    Logs go to stderr (stdout is reserved for the JSON-RPC transport).
    """
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    mcp.run()


if __name__ == "__main__":
    main()
