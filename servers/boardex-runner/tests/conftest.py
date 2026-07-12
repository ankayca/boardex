"""Shared helpers for the runner suite: drive an engine to a terminal state.

All tests are hardware-free (FakeBench + VirtualClock) and run the real engine
and wire layer — the same code paths the live bench uses.
"""

from __future__ import annotations

import asyncio
from typing import Any

from boardex_runner.artifacts import ArtifactStore
from boardex_runner.clock import VirtualClock
from boardex_runner.engine import RunEngine, new_run_id
from boardex_runner.fake_bench import FakeBench, fake_board_profile

TERMINAL = {"completed", "failed", "stopped"}
SPEED = 2000.0  # virtual-clock divisor; a full run finishes in well under a second


def make_engine(
    *,
    fail_variant: bool = False,
    on_event: Any = None,
    artifacts: ArtifactStore | None = None,
) -> RunEngine:
    return RunEngine(
        run_id=new_run_id(),
        task_prompt="Bring up BME280 over I2C on the Nucleo-F303RE. Verify I2C "
        "timing and confirm valid temperature/humidity readings over serial.",
        profile=fake_board_profile(),
        bench=FakeBench(fail_variant=fail_variant),
        clock=VirtualClock(speed=SPEED),
        artifacts=artifacts or ArtifactStore(),
        on_event=on_event,
    )


def pending_approval_id(events: list[dict[str, Any]]) -> str | None:
    requested = [
        e["payload"]["approval"]["id"] for e in events if e["type"] == "approval.requested"
    ]
    resolved = {
        e["payload"]["approvalId"] for e in events if e["type"] == "approval.resolved"
    }
    for approval_id in requested:
        if approval_id not in resolved:
            return approval_id
    return None


async def drive_to_terminal(
    engine: RunEngine,
    *,
    approve_plan: bool = True,
    resolve: str = "approved",
    max_iters: int = 20_000,
) -> list[dict[str, Any]]:
    """Approve the plan and every pending approval until the run is terminal."""
    engine.start()
    for _ in range(max_iters):
        if engine.log.sealed:
            await asyncio.sleep(0)  # let the pipeline task unwind
            return engine.log.events
        events = engine.log.events
        if engine.status == "plan_ready" and approve_plan:
            engine.approve_plan()
        pending = pending_approval_id(events)
        if pending is not None:
            engine.resolve_approval(pending, resolve)
        await asyncio.sleep(0.002)
    raise AssertionError("run did not reach a terminal state in time")


def run(coro: Any) -> Any:
    return asyncio.run(coro)
