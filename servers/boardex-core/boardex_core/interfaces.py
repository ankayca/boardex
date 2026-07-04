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
        self,
        device_id: str,
        *,
        target: str | None = None,
        timeout_s: float = 2.0,
        control_block_address: int | None = None,
        elf_path: str | None = None,
    ) -> OperationResult:
        """Read firmware debug output (RTT/semihosting) for up to ``timeout_s``.

        ``control_block_address`` pins the SEGGER RTT control block location
        (from the firmware's ``_SEGGER_RTT`` symbol) to skip the RAM scan; if
        omitted the backend searches the target's RAM for it. ``elf_path`` lets
        the backend resolve that symbol from the firmware image instead (falling
        back to the last image it flashed to this device).
        """

    @abstractmethod
    def recover(
        self,
        device_id: str,
        *,
        target: str | None = None,
        mass_erase: bool = True,
    ) -> OperationResult:
        """Reclaim a wedged target by connecting under reset.

        The escape hatch for firmware that has disabled the debug port, put the
        core to sleep, or wedged it in a tight loop: the backend asserts the
        reset line *while* connecting so it catches the core before firmware
        runs, halts it, and (if ``mass_erase``) erases flash so the bad image
        cannot re-wedge the board on the next power-up. After a successful
        recover the target is halted and reclaimable by every other tool.
        """

    @abstractmethod
    def get_status(
        self,
        device_id: str,
        *,
        target: str | None = None,
        elf_path: str | None = None,
        halt: bool = False,
    ) -> OperationResult:
        """Report core execution state and decode any latched crash reason.

        Lets the agent tell "crashed (and why)" apart from "just silent". Returns
        whether the core is running or halted, the program counter when halted,
        and a decoded Cortex-M fault reason (from CFSR/HFSR/etc.) when a fault is
        latched. Non-intrusive by default.

        The *faulting* PC and register frame live in the stacked exception frame,
        readable only when halted. Pass ``halt=True`` to halt the core in this
        call and recover them (it was crashed anyway); the core is left halted.

        ``elf_path`` (falling back to the last image flashed to this device) maps
        the current and faulting PCs to ``function (file:line)`` so the agent can
        act on a source location, not a raw address.
        """


class LogicAnalyzer(Backend):
    """Anything that can capture digital logic signals on many channels.

    Implemented by sigrok (fx2lafw, kingst-la2016, ...), and future custom or
    vendor drivers. Individual analyzer models are hidden behind the adapter;
    agents address one by ``device_id`` and describe *what* to capture, never
    *how* a particular device does it.

    Trigger edges are the brand-neutral strings ``"rising"``, ``"falling"``,
    ``"high"`` and ``"low"``. Sample data is returned in a compact, agent-
    friendly form (per-channel transitions + metadata), not as a raw multi-
    megabyte bit dump: the server is a dumb executor that hands back the capture
    and its introspection; the agent judges timing/protocol correctness.
    """

    @abstractmethod
    def capabilities(self, device_id: str) -> OperationResult:
        """Report the device's limits so the agent can plan a valid capture.

        ``data`` should include at least ``channels`` (names/count), the maximum
        ``sample_rate_hz`` (and/or the list of supported rates), whether the
        device streams or captures to on-board memory, and the trigger types it
        supports. Pure introspection; changes nothing.
        """

    @abstractmethod
    def capture(
        self,
        device_id: str,
        *,
        channels: list[int] | None = None,
        sample_rate_hz: int = 1_000_000,
        num_samples: int | None = None,
        duration_s: float | None = None,
        trigger_channel: int | None = None,
        trigger_edge: str = "rising",
    ) -> OperationResult:
        """Capture one acquisition of digital samples.

        Args:
            channels: Channel indices to record (None = all available).
            sample_rate_hz: Requested sampling rate; the backend reports the
                actual rate it used in the result (hardware rounds to what it
                supports).
            num_samples: Number of samples to capture. Provide this or
                ``duration_s`` (num_samples wins if both are given).
            duration_s: Capture length in seconds (converted to samples using the
                actual rate) when ``num_samples`` is not given.
            trigger_channel: Channel to trigger on; None captures immediately.
            trigger_edge: One of ``"rising"``/``"falling"``/``"high"``/``"low"``.

        Returns a result whose ``data`` carries the actual ``sample_rate_hz``,
        ``num_samples``, channel names, and per-channel ``transitions`` (compact
        edge list), so the agent can reason about timing without a raw bit dump.
        """

    def decode(
        self,
        device_id: str,
        protocol: str,
        channel_map: dict[str, int],
        *,
        sample_rate_hz: int = 1_000_000,
        num_samples: int | None = None,
        duration_s: float | None = None,
        options: dict[str, str] | None = None,
    ) -> OperationResult:
        """Capture and run a bus protocol decoder (I2C/SPI/UART/...).

        Turns raw edges into decoded transactions so the agent can check a bus
        against a datasheet instead of eyeballing waveforms. ``protocol`` is a
        backend decoder id; ``channel_map`` binds decoder inputs to channel
        indices (e.g. ``{"scl": 0, "sda": 1}``); ``options`` sets decoder options
        (e.g. ``{"baudrate": "115200"}``). ``data.annotations`` holds the decoded
        stream.

        Optional capability: backends that cannot decode return an
        ``inconclusive`` result (the default here) rather than raising.
        """
        return OperationResult.inconclusive(
            f"{type(self).__name__} does not support protocol decoding."
        )
