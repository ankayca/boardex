"""Boardex shared core: interfaces, results, errors, and the backend registry.

Every Boardex MCP server depends on this package and nothing hardware-specific.
"""

from __future__ import annotations

from .capabilities import (
    NativeSession,
    RttChannel,
    SupportsCoordinatedCapture,
    SupportsHaltModeDebug,
    SupportsPeripheralInspection,
    SupportsRttLocation,
    SupportsSessions,
)
from .errors import (
    BackendUnavailableError,
    BoardexError,
    DeviceBusyError,
    DeviceNotFoundError,
    OperationFailedError,
    RttUnavailableError,
)
from .evidence import EvidenceBundle, WorkflowStep, combine_verdicts
from .facade import guard, list_devices_result
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
    "EvidenceBundle",
    "LogicAnalyzer",
    "NativeSession",
    "OperationFailedError",
    "OperationResult",
    "RttChannel",
    "RttUnavailableError",
    "SupportsCoordinatedCapture",
    "SupportsHaltModeDebug",
    "SupportsPeripheralInspection",
    "SupportsRttLocation",
    "SupportsSessions",
    "TargetController",
    "Verdict",
    "WorkflowStep",
    "combine_verdicts",
    "guard",
    "list_devices_result",
]

__version__ = "0.1.0"
