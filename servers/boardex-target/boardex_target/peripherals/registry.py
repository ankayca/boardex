"""Registry of peripheral inspectors available to ``inspect_peripheral``."""

from __future__ import annotations

from .base import PeripheralInspector
from .stm32_i2c import default_i2c_inspectors

_INSPECTORS: dict[str, PeripheralInspector] = {}


def register(inspector: PeripheralInspector) -> None:
    _INSPECTORS[inspector.name.upper()] = inspector


def get(name: str) -> PeripheralInspector | None:
    return _INSPECTORS.get(name.strip().upper())


def list_supported() -> list[str]:
    return sorted(_INSPECTORS)


def _bootstrap() -> None:
    if _INSPECTORS:
        return
    for inspector in default_i2c_inspectors():
        register(inspector)


_bootstrap()
