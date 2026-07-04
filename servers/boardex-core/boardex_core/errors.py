"""Typed exception hierarchy shared across Boardex servers.

Adapters raise these; the MCP facade layer catches ``BoardexError`` and converts
it into an ``OperationResult`` with ``verdict="error"``. Using specific subclasses
lets the facade produce actionable summaries (e.g. "device busy, is another tool
holding the probe?").
"""

from __future__ import annotations


class BoardexError(Exception):
    """Base class for every expected Boardex failure."""


class BackendUnavailableError(BoardexError):
    """A backend's tooling/SDK is not installed or not importable."""


class DeviceNotFoundError(BoardexError):
    """No device matches the requested ``device_id``."""


class DeviceBusyError(BoardexError):
    """The device is claimed by another process/session (locked USB, etc.)."""


class OperationFailedError(BoardexError):
    """The operation was attempted on real hardware but did not complete."""
