"""Boardex shared core: interfaces, results, errors, and the backend registry.

Every Boardex MCP server depends on this package and nothing hardware-specific.
"""

from __future__ import annotations

from .errors import (
    BackendUnavailableError,
    BoardexError,
    DeviceBusyError,
    DeviceNotFoundError,
    OperationFailedError,
)
from .interfaces import Backend, DeviceInfo, LogicAnalyzer, TargetController
from .registry import BackendRegistry
from .results import OperationResult, Verdict

__all__ = [
    "Backend",
    "BackendRegistry",
    "BackendUnavailableError",
    "BoardexError",
    "DeviceBusyError",
    "DeviceInfo",
    "DeviceNotFoundError",
    "LogicAnalyzer",
    "OperationFailedError",
    "OperationResult",
    "TargetController",
    "Verdict",
]

__version__ = "0.1.0"
