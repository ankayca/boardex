"""Abstract interfaces every backend adapter must implement.

These are the *contract* between the agent-facing MCP tools and the vendor
specific code. Upper layers depend only on what is defined here (Dependency
Inversion), so a new probe/instrument can be added by writing one adapter.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from .results import OperationResult


@dataclass(frozen=True)
class DeviceInfo:
    """Identity of one physical device discovered on the bench.

    ``device_id`` is the stable handle agents use to address the device across
    tool calls; the registry maps it back to the adapter that owns it.
    """

    device_id: str
    kind: str  # "debug_probe", "logic_analyzer", "oscilloscope", ...
    vendor: str
    model: str
    serial: str | None = None
    target: str | None = None  # attached MCU part number, if known
    backend: str = ""  # which adapter owns it, e.g. "pyocd"
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "kind": self.kind,
            "vendor": self.vendor,
            "model": self.model,
            "serial": self.serial,
            "target": self.target,
            "backend": self.backend,
            "extra": self.extra,
        }


class Backend(ABC):
    """Common base for every backend adapter, regardless of domain."""

    #: Short, stable identifier for this backend (e.g. "pyocd", "sigrok").
    backend_name: str = "abstract"

    @abstractmethod
    def scan(self) -> list[DeviceInfo]:
        """Return every device this backend can currently see."""

    def is_available(self) -> bool:
        """Whether the underlying SDK/tooling is installed and usable.

        Override to probe for the vendor dependency. Defaults to True so simple
        adapters need not implement it.
        """
        return True


class TargetController(Backend):
    """Anything that can flash and debug an MCU target.

    Implemented by pyOCD, OpenOCD, STM32CubeProgrammer, J-Link, ... adapters.
    ``target`` (an MCU part number such as "stm32f411re") may be required by some
    probes that cannot auto-detect the connected die.
    """

    @abstractmethod
    def flash(
        self,
        device_id: str,
        firmware_path: str,
        *,
        target: str | None = None,
        verify: bool = True,
        reset_after: bool = True,
    ) -> OperationResult:
        """Program ``firmware_path`` (.elf/.hex/.bin) onto the target."""

    @abstractmethod
    def reset(
        self, device_id: str, *, target: str | None = None, halt: bool = False
    ) -> OperationResult:
        """Reset the target; optionally halt the core immediately after reset."""

    @abstractmethod
    def halt(self, device_id: str, *, target: str | None = None) -> OperationResult:
        """Halt the core."""

    @abstractmethod
    def resume(self, device_id: str, *, target: str | None = None) -> OperationResult:
        """Resume the core."""

    @abstractmethod
    def read_memory(
        self, device_id: str, address: int, length: int, *, target: str | None = None
    ) -> OperationResult:
        """Read ``length`` bytes starting at ``address``."""

    @abstractmethod
    def write_memory(
        self,
        device_id: str,
        address: int,
        data: bytes,
        *,
        target: str | None = None,
    ) -> OperationResult:
        """Write ``data`` starting at ``address``."""

    @abstractmethod
    def read_log(
        self, device_id: str, *, target: str | None = None, timeout_s: float = 2.0
    ) -> OperationResult:
        """Read firmware debug output (RTT/semihosting) for up to ``timeout_s``."""
