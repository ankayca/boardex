"""Registered peripheral inspectors (STM32 I2C today; more families plug in here)."""

from . import inspect, registry
from .base import InspectResult, MemoryRead, PeripheralInspector

__all__ = [
    "InspectResult",
    "MemoryRead",
    "PeripheralInspector",
    "inspect",
    "registry",
]
