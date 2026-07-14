"""Composite bring-up tools: whole agent-loop iterations in a single call."""

from __future__ import annotations

from typing import Any

from boardex_core import BackendRegistry, TargetController
from mcp.server.fastmcp import FastMCP

from .. import workflows
from ..session import SessionManager
from . import guarded as _guard


def register(
    mcp: FastMCP,
    registry: BackendRegistry[TargetController],
    sessions: SessionManager,
) -> None:
    """Define the composite workflow tools onto ``mcp``."""

    @mcp.tool()
    def run_checkpoint(
        device_id: str,
        rtt_pattern: str,
        target: str | None = None,
        session_id: str | None = None,
        project_dir: str | None = None,
        firmware_path: str | None = None,
        build_command: str | None = None,
        artifact: str | None = None,
        clean: bool = False,
        rtt_timeout_s: float = 10.0,
        inspect_on_failure: str | None = None,
        elf_path: str | None = None,
    ) -> dict[str, Any]:
        """One-shot build → flash → RTT checkpoint with bundled evidence.

        Runs the core agent loop in a single call. Opens a session automatically when
        ``session_id`` is omitted (and leaves it open — reuse ``data.session_id``).
        On RTT timeout, optionally inspects a peripheral (pass ``inspect_on_failure``,
        e.g. ``"I2C1"``) and attaches decoded registers/pins/hints to
        ``data.evidence``.

        Branch on ``data.evidence.verdict`` and ``data.evidence.rtt.matched``.
        """
        spec = workflows.CheckpointSpec(
            device_id=device_id,
            target=target,
            session_id=session_id,
            project_dir=project_dir,
            firmware_path=firmware_path,
            build_command=build_command,
            artifact=artifact,
            clean=clean,
            rtt_pattern=rtt_pattern,
            rtt_timeout_s=rtt_timeout_s,
            inspect_on_failure=inspect_on_failure,
            elf_path=elf_path,
        )
        return _guard(
            lambda: workflows.run_checkpoint(registry, sessions, spec)
        ).to_dict()

    @mcp.tool()
    def reset_and_capture_i2c(
        device_id: str,
        logic_analyzer_id: str,
        channel_map: dict[str, int],
        target: str | None = None,
        sample_rate_hz: int = 4_000_000,
        duration_s: float = 0.1,
        trigger_channel: int | None = None,
        trigger_edge: str = "falling",
        options: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Reset-and-halt the MCU, arm an I2C capture, then resume the target.

        Use this for startup-only traffic such as a sensor chip-ID read. The
        target cannot execute between reset and analyzer arming, so the first
        SCL edge deterministically triggers the capture.
        """
        return _guard(
            lambda: workflows.reset_and_capture_i2c(
                registry,
                device_id=device_id,
                target=target,
                logic_analyzer_id=logic_analyzer_id,
                channel_map=channel_map,
                sample_rate_hz=sample_rate_hz,
                duration_s=duration_s,
                trigger_channel=trigger_channel,
                trigger_edge=trigger_edge,
                options=options,
                sessions=sessions,
            )
        ).to_dict()

    @mcp.tool()
    def verify_bringup(
        device_id: str,
        rtt_pattern: str,
        target: str | None = None,
        session_id: str | None = None,
        logic_analyzer_id: str | None = None,
        project_dir: str | None = None,
        firmware_path: str | None = None,
        build_command: str | None = None,
        artifact: str | None = None,
        clean: bool = False,
        rtt_timeout_s: float = 10.0,
        i2c_channel_map: dict[str, int] | None = None,
        i2c_expect: list[dict[str, Any]] | None = None,
        sample_rate_hz: int = 4_000_000,
        i2c_duration_s: float = 0.1,
        trigger_channel: int | None = None,
        trigger_edge: str = "falling",
        reset_before_i2c_capture: bool = True,
        inspect_on_failure: str | None = None,
        elf_path: str | None = None,
    ) -> dict[str, Any]:
        """Verify sensor bring-up with RTT proof and optional logic-analyzer I2C proof.

        Composite workflow: build (optional) → flash → wait for RTT → halt target
        at reset → arm analyzer → resume and capture/decode I2C (when
        ``logic_analyzer_id`` and ``i2c_channel_map`` are set). Requires
        ``boardex-logic`` installed in the same environment for bus proof.

        ``i2c_expect`` is a list of expected transactions, e.g.
        ``[{"addr_7bit": 119, "rw": "w", "write": [208]},
          {"addr_7bit": 119, "rw": "r", "read": [85]}]`` for BMP180 chip ID 0x55.

        Returns ``data.evidence`` bundling RTT excerpt, I2C transactions, peripheral
        snapshot (on failure), hints, and a step audit trail.
        """
        spec = workflows.BringupSpec(
            checkpoint=workflows.CheckpointSpec(
                device_id=device_id,
                target=target,
                session_id=session_id,
                project_dir=project_dir,
                firmware_path=firmware_path,
                build_command=build_command,
                artifact=artifact,
                clean=clean,
                rtt_pattern=rtt_pattern,
                rtt_timeout_s=rtt_timeout_s,
                inspect_on_failure=inspect_on_failure,
                elf_path=elf_path,
            ),
            logic_analyzer_id=logic_analyzer_id,
            i2c_channel_map=i2c_channel_map,
            i2c_expect=i2c_expect,
            sample_rate_hz=sample_rate_hz,
            i2c_duration_s=i2c_duration_s,
            trigger_channel=trigger_channel,
            trigger_edge=trigger_edge,
            reset_before_i2c_capture=reset_before_i2c_capture,
        )
        return _guard(
            lambda: workflows.verify_bringup(registry, sessions, spec)
        ).to_dict()
