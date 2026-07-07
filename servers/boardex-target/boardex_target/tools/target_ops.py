"""Stateless target operations: discovery, build, flash, CPU control, memory,
peripherals, one-shot logs, recovery, and status."""

from __future__ import annotations

from typing import Any

from boardex_core import (
    BackendRegistry,
    OperationResult,
    SupportsPeripheralInspection,
    TargetController,
    list_devices_result,
)
from mcp.server.fastmcp import FastMCP

from .. import builder
from . import guarded as _guard


def register(
    mcp: FastMCP, registry: BackendRegistry[TargetController]
) -> None:
    """Define the stateless target tools onto ``mcp``."""

    @mcp.tool()
    def list_targets() -> dict[str, Any]:
        """List every debug probe / MCU target currently connected to the bench.

        Returns a result whose ``data.devices`` is a list of device descriptors. Use
        each device's ``device_id`` in the other tools.
        """
        return list_devices_result(registry, "target").to_dict()

    @mcp.tool()
    def build_firmware(
        project_dir: str,
        command: str | None = None,
        artifact: str | None = None,
        env: dict[str, str] | None = None,
        clean: bool = False,
        timeout_s: float = 600.0,
    ) -> dict[str, Any]:
        """Build an external firmware project and return the built artifact path.

        Runs the project's own build command (framework/vendor-neutral), captures
        structured compiler errors/warnings, and reports the resulting firmware
        image so it can be handed straight to ``flash_firmware``.

        Args:
            project_dir: Absolute path to the firmware project (external to Boardex).
            command: Build command as a shell string (e.g. "make CROSS=/path/arm-none-eabi-").
                If omitted, auto-detected from the project (Makefile -> make,
                CMakeLists.txt -> cmake, platformio.ini -> pio run, ...).
            artifact: Optional path/glob (relative to the project) pinning the output
                image; otherwise the newest .elf/.hex/.bin/.uf2 built is reported.
            env: Extra environment variables (e.g. to put a cross-toolchain on PATH).
            clean: Run the build system's clean step first (make/cmake only).
            timeout_s: Abort the build after this many seconds.

        Verdict: ``pass`` on exit 0, ``fail`` on compile/link errors, ``error`` if
        the build could not be started. The built image is in ``data.artifact_path``.
        """
        return _guard(
            lambda: builder.build_firmware(
                project_dir,
                command,
                artifact=artifact,
                env=env,
                clean=clean,
                timeout_s=timeout_s,
            )
        ).to_dict()

    @mcp.tool()
    def flash_firmware(
        device_id: str,
        firmware_path: str,
        target: str | None = None,
        verify: bool = True,
        reset_after: bool = True,
    ) -> dict[str, Any]:
        """Flash a firmware image (.elf/.hex/.bin) onto a target and reset it.

        Args:
            device_id: Id from ``list_targets`` (e.g. "pyocd:0670FF...").
            firmware_path: Absolute path to the firmware image on this machine.
            target: MCU part number (e.g. "stm32f411re"). Often required for ST-Link
                probes that cannot auto-detect the connected die.
            verify: Verify flash contents after programming.
            reset_after: Reset the target once programming completes.
        """
        return _guard(
            lambda: registry.resolve(device_id).flash(
                device_id,
                firmware_path,
                target=target,
                verify=verify,
                reset_after=reset_after,
            )
        ).to_dict()

    @mcp.tool()
    def reset_target(
        device_id: str, target: str | None = None, halt: bool = False
    ) -> dict[str, Any]:
        """Reset a target. Set ``halt=True`` to stop the core right after reset."""
        return _guard(
            lambda: registry.resolve(device_id).reset(device_id, target=target, halt=halt)
        ).to_dict()

    @mcp.tool()
    def halt_target(device_id: str, target: str | None = None) -> dict[str, Any]:
        """Halt the target's CPU core."""
        return _guard(
            lambda: registry.resolve(device_id).halt(device_id, target=target)
        ).to_dict()

    @mcp.tool()
    def resume_target(device_id: str, target: str | None = None) -> dict[str, Any]:
        """Resume the target's CPU core."""
        return _guard(
            lambda: registry.resolve(device_id).resume(device_id, target=target)
        ).to_dict()

    @mcp.tool()
    def read_memory(
        device_id: str, address: int, length: int, target: str | None = None
    ) -> dict[str, Any]:
        """Read ``length`` bytes from ``address``; returns hex in ``data.hex``."""
        return _guard(
            lambda: registry.resolve(device_id).read_memory(
                device_id, address, length, target=target
            )
        ).to_dict()

    @mcp.tool()
    def inspect_peripheral(
        device_id: str,
        peripheral: str,
        target: str | None = None,
    ) -> dict[str, Any]:
        """Decode a live on-chip peripheral into structured register and pin fields.

        Reads the peripheral's register block over the debug probe and returns
        decoded flags (not raw hex only). Useful when RTT says a bus op failed but
        you need to know whether clocks, pin mux, or status flags explain it.

        Args:
            device_id: Id from ``list_targets``.
            peripheral: Registered name, e.g. ``"I2C1"`` or ``"I2C2"`` (family-
                qualified as ``"stm32:I2C1"`` when several silicon families provide
                the name). Call with an unknown name to get ``data.supported``
                listing what's available.
            target: MCU part when the probe cannot auto-detect (e.g. ``stm32f303re``).

        Returns ``data.registers`` (decoded CR/SR fields), ``data.pins`` (GPIO mode,
        AF, open-drain), ``data.clocks``, and ``data.hints`` (actionable notes).
        New silicon families register additional names without changing this tool.
        """
        adapter = registry.resolve(device_id)
        if not isinstance(adapter, SupportsPeripheralInspection):
            return OperationResult.errored(
                f"Backend {adapter.backend_name!r} does not support peripheral inspection."
            ).to_dict()
        return _guard(
            lambda: adapter.inspect_peripheral(device_id, peripheral, target=target)
        ).to_dict()

    @mcp.tool()
    def write_memory(
        device_id: str, address: int, hex_data: str, target: str | None = None
    ) -> dict[str, Any]:
        """Write bytes (given as a hex string, e.g. "deadbeef") to ``address``."""
        try:
            data = bytes.fromhex(hex_data)
        except ValueError as exc:
            return OperationResult.errored(f"Invalid hex_data: {exc}").to_dict()
        return _guard(
            lambda: registry.resolve(device_id).write_memory(
                device_id, address, data, target=target
            )
        ).to_dict()

    @mcp.tool()
    def read_firmware_log(
        device_id: str,
        target: str | None = None,
        timeout_s: float = 2.0,
        control_block_address: int | None = None,
        elf_path: str | None = None,
    ) -> dict[str, Any]:
        """Read firmware debug output over SEGGER RTT for up to ``timeout_s`` seconds.

        Attaches to the running core and drains the RTT up channel into ``data.text``.
        The RTT control block is located automatically from the ``_SEGGER_RTT`` symbol
        in ``elf_path`` (or the last image flashed to this device); pass
        ``control_block_address`` to override, or neither to fall back to a RAM scan.
        Returns verdict ``inconclusive`` if the firmware isn't using RTT.
        """
        return _guard(
            lambda: registry.resolve(device_id).read_log(
                device_id,
                target=target,
                timeout_s=timeout_s,
                control_block_address=control_block_address,
                elf_path=elf_path,
            )
        ).to_dict()

    @mcp.tool()
    def recover_target(
        device_id: str, target: str | None = None, mass_erase: bool = True
    ) -> dict[str, Any]:
        """Reclaim a wedged board by connecting under reset (and erasing flash).

        The escape hatch when firmware has disabled SWD, put the core to sleep, or
        spun it in a tight loop so normal connect/halt fails. Asserts reset while
        connecting to catch the core before firmware runs, halts it, and (by default)
        mass-erases flash so the bad image can't re-wedge the board on reset. Leave
        ``mass_erase=False`` to keep flash and just regain a halted core.

        Close any open debug session on the device first: connect-under-reset needs
        an exclusive, fresh connection to the probe.
        """
        return _guard(
            lambda: registry.resolve(device_id).recover(
                device_id, target=target, mass_erase=mass_erase
            )
        ).to_dict()

    @mcp.tool()
    def read_chip_status(
        device_id: str,
        target: str | None = None,
        elf_path: str | None = None,
        halt: bool = False,
    ) -> dict[str, Any]:
        """Report core state (running/halted, PC) and decode any latched crash.

        Non-intrusive introspection to tell "crashed (and why)" apart from "just
        silent": reads the run state, the program counter when halted, and decodes
        the Cortex-M fault registers (CFSR/HFSR/BFAR) into a human/agent-readable
        reason. ``data.faulted`` and ``data.in_fault_handler`` flag a crash;
        ``data.faults.reason`` explains it.

        The *faulting* PC lives in the stacked exception frame, readable only when
        halted. For a running crashed core, pass ``halt=True`` to halt and recover
        it in one call (``data.fault_pc``); the core is left halted. With an ELF
        (``elf_path``, or the last image flashed here) the faulting/current PCs are
        resolved to ``function (file:line)`` in ``data.fault_location`` /
        ``data.pc_location``.
        """
        return _guard(
            lambda: registry.resolve(device_id).get_status(
                device_id, target=target, elf_path=elf_path, halt=halt
            )
        ).to_dict()
