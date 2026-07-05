"""Peripheral inspection helpers for target debug adapters."""

from __future__ import annotations

from collections.abc import Callable

from boardex_core import OperationResult

from . import registry


def inspect(
    read_block: Callable[[int, int], bytes],
    peripheral: str,
) -> OperationResult:
    """Fetch and decode one registered peripheral.

    ``read_block(address, length) -> bytes`` is supplied by the adapter (pyOCD,
    J-Link, ...). Keeps this module free of vendor SDK imports.
    """
    profile = registry.get(peripheral)
    if profile is None:
        return OperationResult.errored(
            f"Unknown peripheral {peripheral!r}.",
            peripheral=peripheral,
            supported=registry.list_supported(),
        )

    blocks: dict[str, bytes] = {}
    reads = profile.memory_reads()
    for spec in reads:
        try:
            blocks[spec.label] = read_block(spec.address, spec.length)
        except Exception as exc:  # noqa: BLE001 - surface probe errors cleanly
            return OperationResult.errored(
                f"Failed reading {spec.label} @ {spec.address:#010x}: {exc}",
                peripheral=peripheral,
                failed_read={"label": spec.label, "address": spec.address},
            )

    decoded = profile.decode(blocks)
    summary = f"Inspected {profile.name} ({profile.family})."
    if decoded.get("hints"):
        summary += f" {len(decoded['hints'])} hint(s)."

    return OperationResult.passed(
        summary,
        **decoded,
        description=profile.description,
    )
