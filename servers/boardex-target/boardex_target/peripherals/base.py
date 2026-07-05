"""Peripheral inspection contract for target debug adapters.

Inspectors are pure register maps + decoders registered by name (``I2C1``,
``USART1``, ...). The MCP tool reads live memory through the adapter and feeds
bytes into ``decode``; no vendor SDK leaks into this layer.

New silicon families add a module under ``peripherals/`` and call
``registry.register`` — the agent-facing tool stays unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class MemoryRead:
    """One contiguous debug read the inspector needs."""

    label: str
    address: int
    length: int


class PeripheralInspector(Protocol):
    """Decode one on-chip peripheral from raw register bytes."""

    name: str
    family: str
    description: str

    def memory_reads(self) -> list[MemoryRead]:
        """Register blocks to fetch (label -> decode key)."""

    def decode(self, blocks: dict[str, bytes]) -> dict[str, Any]:
        """Turn fetched bytes into an agent-friendly structured view."""


@dataclass
class InspectResult:
    """Structured payload returned by ``inspect_peripheral``."""

    peripheral: str
    family: str
    registers: dict[str, Any] = field(default_factory=dict)
    pins: dict[str, Any] = field(default_factory=dict)
    clocks: dict[str, Any] = field(default_factory=dict)
    hints: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "peripheral": self.peripheral,
            "family": self.family,
            "registers": self.registers,
            "pins": self.pins,
            "clocks": self.clocks,
            "hints": self.hints,
        }
