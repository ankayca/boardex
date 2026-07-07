"""Optional adapter capabilities, declared as runtime-checkable Protocols.

The abstract interfaces in ``interfaces.py`` define what *every* backend of a
domain must do. Capabilities here are opt-in extras a backend *may* support
(persistent sessions, peripheral decoding, RTT symbol lookup, ...). Upper
layers test for them with ``isinstance(adapter, SupportsX)`` instead of
duck-typed ``getattr`` probing, so the contract a contributor must implement
is explicit and type-checkable.
"""

from __future__ import annotations

from typing import Any, Callable, Protocol, runtime_checkable

from .results import OperationResult


@runtime_checkable
class RttChannel(Protocol):
    """One open firmware log (RTT up) channel.

    ``read()`` must be safe to call from a background polling thread — the
    backend's native session is responsible for any locking the vendor SDK
    needs.
    """

    name: str

    def read(self) -> bytes:
        """Return whatever bytes are pending (possibly empty), without blocking."""
        ...


@runtime_checkable
class NativeSession(Protocol):
    """A live, backend-owned connection to one device.

    Wraps whatever the vendor SDK calls a "session"/"handle" so the shared
    session layer can hold it open, serialise access to it, and close it
    without knowing which vendor it came from. Implementations must serialise
    concurrent access to the device internally (one probe is rarely
    thread-safe).
    """

    def run(self, operation: Callable[[Any], OperationResult]) -> OperationResult:
        """Execute ``operation`` against the underlying vendor session object."""
        ...

    def open_rtt(self, *, control_block_address: int | None = None) -> RttChannel:
        """Open the firmware log stream (RTT up channel).

        Raises ``RttUnavailableError`` when the target has no control block
        (firmware built without RTT) or the backend does not support RTT.
        """
        ...

    def close(self) -> None:
        """Release the device/probe."""
        ...


@runtime_checkable
class SupportsSessions(Protocol):
    """Backend can open persistent (long-lived) device sessions."""

    def probe_unique_id(self, device_id: str) -> str:
        """Map a Boardex ``device_id`` to the backend's raw probe identifier."""
        ...

    def open_native_session(
        self, device_id: str, *, target: str | None = None
    ) -> NativeSession:
        """Open and return a live vendor session for ``device_id``.

        The returned session must be attached without perturbing the running
        target (so firmware keeps executing and log streaming can start
        immediately).
        """
        ...


@runtime_checkable
class SupportsPeripheralInspection(Protocol):
    """Backend can decode live on-chip peripheral register blocks."""

    def inspect_peripheral(
        self,
        device_id: str,
        peripheral: str,
        *,
        target: str | None = None,
    ) -> OperationResult: ...


@runtime_checkable
class SupportsRttLocation(Protocol):
    """Backend can resolve the SEGGER RTT control-block address for a device."""

    def rtt_control_block(
        self, device_id: str, elf_path: str | None = None
    ) -> int | None: ...
