"""Reference fake adapters: hardware-free implementations of the contracts.

Used by Boardex's own tests and offered to contributors as living examples of
what a conforming adapter looks like (including the optional capability
protocols).
"""

from __future__ import annotations

from typing import Any, Callable

from ..errors import DeviceNotFoundError, RttUnavailableError
from ..interfaces import DeviceInfo, LogicAnalyzer, TargetController
from ..results import OperationResult


class FakeRttChannel:
    """In-memory RTT up channel fed by ``FakeTargetController.emit_rtt``."""

    name = "Terminal"

    def __init__(self) -> None:
        self._pending = bytearray()

    def feed(self, data: bytes) -> None:
        self._pending.extend(data)

    def read(self) -> bytes:
        data = bytes(self._pending)
        self._pending.clear()
        return data


class FakeNativeSession:
    """``NativeSession`` implementation over an in-memory device."""

    def __init__(self, rtt_channel: FakeRttChannel | None = None) -> None:
        self.closed = False
        self._rtt_channel = rtt_channel

    def run(self, operation: Callable[[Any], OperationResult]) -> OperationResult:
        return operation(self)

    def open_rtt(self, *, control_block_address: int | None = None) -> FakeRttChannel:
        if self._rtt_channel is None:
            raise RttUnavailableError(
                "Fake target has no RTT control block (configure one in the fake)."
            )
        return self._rtt_channel

    def close(self) -> None:
        self.closed = True


class FakeTargetController(TargetController):
    """In-memory ``TargetController`` implementing every optional capability.

    Simulates one connected probe (``fake-target:0``) with a byte-addressable
    memory dict, a running/halted flag, and an optional RTT channel.
    """

    backend_name = "fake-target"

    def __init__(self, *, with_rtt: bool = True) -> None:
        self.memory: dict[int, int] = {}
        self.halted = False
        self.flashed: list[str] = []
        self.rtt_channel = FakeRttChannel() if with_rtt else None
        self.native_sessions: list[FakeNativeSession] = []

    # -- Backend -------------------------------------------------------------

    def scan(self) -> list[DeviceInfo]:
        return [
            DeviceInfo(
                device_id=f"{self.backend_name}:0",
                kind="debug_probe",
                vendor="Boardex",
                model="Fake Probe",
                serial="0",
                backend=self.backend_name,
            )
        ]

    def _check(self, device_id: str) -> None:
        if device_id != f"{self.backend_name}:0":
            raise DeviceNotFoundError(f"No fake device with id '{device_id}'.")

    # -- TargetController ------------------------------------------------------

    def flash(
        self,
        device_id: str,
        firmware_path: str,
        *,
        target: str | None = None,
        verify: bool = True,
        reset_after: bool = True,
    ) -> OperationResult:
        self._check(device_id)
        self.flashed.append(firmware_path)
        return OperationResult.passed(
            f"Flashed '{firmware_path}'.", firmware_path=firmware_path
        )

    def reset(
        self, device_id: str, *, target: str | None = None, halt: bool = False
    ) -> OperationResult:
        self._check(device_id)
        self.halted = halt
        return OperationResult.passed("Target reset.", halted=halt)

    def halt(self, device_id: str, *, target: str | None = None) -> OperationResult:
        self._check(device_id)
        self.halted = True
        return OperationResult.passed("Target halted.")

    def resume(self, device_id: str, *, target: str | None = None) -> OperationResult:
        self._check(device_id)
        self.halted = False
        return OperationResult.passed("Target resumed.")

    def read_memory(
        self, device_id: str, address: int, length: int, *, target: str | None = None
    ) -> OperationResult:
        self._check(device_id)
        data = bytes(self.memory.get(address + i, 0) for i in range(length))
        return OperationResult.passed(
            f"Read {length} bytes @ {address:#010x}.", hex=data.hex(), length=length
        )

    def write_memory(
        self,
        device_id: str,
        address: int,
        data: bytes,
        *,
        target: str | None = None,
    ) -> OperationResult:
        self._check(device_id)
        for i, byte in enumerate(data):
            self.memory[address + i] = byte
        return OperationResult.passed(f"Wrote {len(data)} bytes @ {address:#010x}.")

    def read_log(
        self,
        device_id: str,
        *,
        target: str | None = None,
        timeout_s: float = 2.0,
        control_block_address: int | None = None,
        elf_path: str | None = None,
    ) -> OperationResult:
        self._check(device_id)
        if self.rtt_channel is None:
            return OperationResult.inconclusive("Fake target has no RTT.")
        text = self.rtt_channel.read().decode("utf-8", "backslashreplace")
        return OperationResult.passed(
            f"Read {len(text)} bytes of RTT output.", text=text
        )

    def recover(
        self,
        device_id: str,
        *,
        target: str | None = None,
        mass_erase: bool = True,
    ) -> OperationResult:
        self._check(device_id)
        if mass_erase:
            self.memory.clear()
        self.halted = True
        return OperationResult.passed("Recovered target.", mass_erased=mass_erase)

    def get_status(
        self,
        device_id: str,
        *,
        target: str | None = None,
        elf_path: str | None = None,
        halt: bool = False,
    ) -> OperationResult:
        self._check(device_id)
        if halt:
            self.halted = True
        return OperationResult.passed(
            "Core is halted." if self.halted else "Core is running.",
            halted=self.halted,
            running=not self.halted,
            faulted=False,
        )

    # -- optional capabilities ---------------------------------------------

    def probe_unique_id(self, device_id: str) -> str:
        self._check(device_id)
        return "0"

    def open_native_session(
        self, device_id: str, *, target: str | None = None
    ) -> FakeNativeSession:
        self._check(device_id)
        native = FakeNativeSession(self.rtt_channel)
        self.native_sessions.append(native)
        return native

    def rtt_control_block(
        self, device_id: str, elf_path: str | None = None
    ) -> int | None:
        return 0x2000_0000 if self.rtt_channel is not None else None

    def inspect_peripheral(
        self,
        device_id: str,
        peripheral: str,
        *,
        target: str | None = None,
    ) -> OperationResult:
        self._check(device_id)
        return OperationResult.passed(
            f"Inspected {peripheral} (fake).",
            peripheral=peripheral,
            family="fake",
            registers={},
            pins={},
            clocks={},
            hints=[],
        )

    # -- test helpers ---------------------------------------------------------

    def emit_rtt(self, text: str) -> None:
        """Simulate firmware writing to the RTT up channel."""
        if self.rtt_channel is not None:
            self.rtt_channel.feed(text.encode())


class FakeLogicAnalyzer(LogicAnalyzer):
    """In-memory ``LogicAnalyzer`` returning canned captures/decodes."""

    backend_name = "fake-logic"

    def __init__(
        self,
        *,
        transitions: dict[str, list[list[int]]] | None = None,
        transactions: list[dict[str, Any]] | None = None,
    ) -> None:
        self.transitions = transitions or {"D0": [[0, 0], [10, 1], [20, 0]]}
        self.transactions = transactions if transactions is not None else []

    def scan(self) -> list[DeviceInfo]:
        return [
            DeviceInfo(
                device_id=f"{self.backend_name}:0",
                kind="logic_analyzer",
                vendor="Boardex",
                model="Fake LA",
                serial="0",
                backend=self.backend_name,
            )
        ]

    def _check(self, device_id: str) -> None:
        if device_id != f"{self.backend_name}:0":
            raise DeviceNotFoundError(f"No fake analyzer with id '{device_id}'.")

    def capabilities(self, device_id: str) -> OperationResult:
        self._check(device_id)
        return OperationResult.passed(
            "8-channel fake analyzer.",
            channels=[f"D{i}" for i in range(8)],
            channel_count=8,
            max_sample_rate_hz=24_000_000,
            samplerates=[1_000_000, 4_000_000, 24_000_000],
            triggers=["rising", "falling", "high", "low"],
        )

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
        self._check(device_id)
        n = num_samples or int((duration_s or 0.001) * sample_rate_hz)
        return OperationResult.passed(
            f"Captured {n} samples.",
            sample_rate_hz=sample_rate_hz,
            num_samples=n,
            duration_s=n / sample_rate_hz,
            transitions=self.transitions,
            measurements={
                name: {"active": len(edges) > 1, "edges": max(len(edges) - 1, 0)}
                for name, edges in self.transitions.items()
            },
        )

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
        trigger_channel: int | None = None,
        trigger_edge: str = "rising",
    ) -> OperationResult:
        self._check(device_id)
        if not self.transactions:
            return OperationResult.inconclusive(
                "No bus activity decoded (idle bus).",
                annotations=[],
                transactions=[],
                bus_state="idle_bus",
            )
        return OperationResult.passed(
            f"Decoded {len(self.transactions)} {protocol} transaction(s).",
            annotations=[],
            transactions=self.transactions,
            bus_state="decoded_ok",
        )
