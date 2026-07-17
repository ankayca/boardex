#!/usr/bin/env python3
"""Drive AgentBench hardware bring-up stages over the runner HTTP API."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from typing import Any

import aiohttp

TERMINAL = frozenset({"completed", "failed", "stopped"})
POLL_S = 0.5

STAGE_A_PROMPT = (
    "Change the console output format to print PRESSURE=<p> alongside the "
    "existing output, and build it."
)

STAGE_B_PROMPT = """Write an I2C driver for BMP180 on STM32F303RE from scratch.
- I2C1: SDA=PB9, SCL=PB8
- LA wiring: CH0=SDA, CH1=SCL
Goal: verify sensor is working."""

STAGE_C_REJECT_PROMPT = (
    "Build the firmware in the repo and flash it to verify the probe works."
)


def _status_of(events: list[dict[str, Any]]) -> str:
    status = "draft"
    for event in events:
        if event["type"] == "run.created":
            status = event["payload"]["run"]["status"]
        elif event["type"] == "run.status_changed":
            status = event["payload"]["status"]
        elif event["type"] in ("run.completed", "run.failed", "run.stopped"):
            status = event["type"].split(".")[1]
    return status


def _pending_approval(events: list[dict[str, Any]]) -> str | None:
    requested = [
        e["payload"]["approval"]["id"] for e in events if e["type"] == "approval.requested"
    ]
    resolved = {e["payload"]["approvalId"] for e in events if e["type"] == "approval.resolved"}
    return next((a for a in requested if a not in resolved), None)


def _checks(events: list[dict[str, Any]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for event in events:
        if event["type"] == "check.evaluated":
            check = event["payload"]["check"]
            out[check["requirementId"]] = check["verdict"]
    return out


async def _fetch_events(session: aiohttp.ClientSession, base: str, run_id: str) -> list[dict[str, Any]]:
    async with session.get(f"{base}/runs/{run_id}/events?afterSeq=0") as res:
        res.raise_for_status()
        return await res.json()


async def _create_run(
    session: aiohttp.ClientSession, base: str, prompt: str, profile: str
) -> str:
    async with session.post(
        f"{base}/runs",
        json={"taskPrompt": prompt, "boardProfileId": profile},
    ) as res:
        body = await res.text()
        if res.status != 200:
            raise RuntimeError(f"create run failed: {res.status} {body}")
        return json.loads(body)["runId"]


async def _approve_plan(session: aiohttp.ClientSession, base: str, run_id: str) -> None:
    async with session.post(f"{base}/runs/{run_id}/plan/approve") as res:
        if res.status != 204:
            raise RuntimeError(f"plan approve failed: {res.status} {await res.text()}")


async def _resolve_approval(
    session: aiohttp.ClientSession,
    base: str,
    run_id: str,
    approval_id: str,
    *,
    status: str,
) -> None:
    async with session.post(
        f"{base}/runs/{run_id}/approvals/{approval_id}",
        json={"status": status},
    ) as res:
        if res.status != 204:
            raise RuntimeError(
                f"approval {approval_id} -> {status} failed: {res.status} {await res.text()}"
            )


async def _stop_run(session: aiohttp.ClientSession, base: str, run_id: str) -> float:
    t0 = time.monotonic()
    async with session.post(f"{base}/runs/{run_id}/stop") as res:
        if res.status != 204:
            raise RuntimeError(f"stop failed: {res.status} {await res.text()}")
    return time.monotonic() - t0


async def drive_run(
    base: str,
    prompt: str,
    *,
    timeout_s: float,
    approve_hardware: bool,
    reject_next_hardware: bool = False,
) -> tuple[str, str, list[dict[str, Any]]]:
    async with aiohttp.ClientSession() as session:
        run_id = await _create_run(session, base, prompt, "bp_nucleo_f303re")
        print(f"run_id={run_id}")
        resolved: set[str] = set()
        rejected = False
        deadline = asyncio.get_event_loop().time() + timeout_s
        events: list[dict[str, Any]] = []

        while asyncio.get_event_loop().time() < deadline:
            events = await _fetch_events(session, base, run_id)
            status = _status_of(events)
            seq = events[-1]["seq"] if events else 0
            print(f"  status={status} seq={seq}")

            if status in TERMINAL:
                break

            if status == "plan_ready" and "__plan__" not in resolved:
                await _approve_plan(session, base, run_id)
                resolved.add("__plan__")
                print("  approved plan")

            pending = _pending_approval(events)
            if pending and pending not in resolved:
                if reject_next_hardware and not rejected:
                    await _resolve_approval(session, base, run_id, pending, status="rejected")
                    resolved.add(pending)
                    rejected = True
                    print(f"  rejected {pending}")
                elif approve_hardware:
                    await _resolve_approval(session, base, run_id, pending, status="approved")
                    resolved.add(pending)
                    print(f"  approved {pending}")

            await asyncio.sleep(POLL_S)
        else:
            raise TimeoutError(f"run {run_id} did not reach terminal state within {timeout_s}s")

        terminal = _status_of(events)
        print(f"terminal={terminal}")
        for req, verdict in sorted(_checks(events).items()):
            print(f"  check {req}: {verdict}")
        return run_id, terminal, events


async def wait_for_capture(session: aiohttp.ClientSession, base: str, run_id: str) -> None:
    """Poll until a capture step is active (for stage-c stop latency)."""
    for _ in range(120):
        events = await _fetch_events(session, base, run_id)
        for event in reversed(events):
            if event["type"] == "step.started":
                title = event["payload"]["step"].get("title", "").lower()
                if "capture" in title or "decode" in title:
                    print(f"  capture step active: {event['payload']['step']['id']}")
                    return
        await asyncio.sleep(1)
    print("  warning: no capture step detected within 120s", file=sys.stderr)


async def run_stage_c_stop(base: str, run_id: str) -> int:
    async with aiohttp.ClientSession() as session:
        await wait_for_capture(session, base, run_id)
        latency = await _stop_run(session, base, run_id)
        print(f"stop HTTP ack latency: {latency:.3f}s")
        t0 = time.monotonic()
        for _ in range(60):
            events = await _fetch_events(session, base, run_id)
            if _status_of(events) in TERMINAL:
                print(f"terminal={_status_of(events)} after {time.monotonic() - t0:.3f}s")
                return 0
            await asyncio.sleep(0.5)
        print("timeout waiting for terminal after stop", file=sys.stderr)
        return 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:4380")
    parser.add_argument("--timeout", type=float, default=1800.0)
    parser.add_argument("--run-id")
    parser.add_argument("command", choices=["stage-a", "stage-b", "stage-c-reject", "stage-c-stop"])
    args = parser.parse_args()
    base = args.base.rstrip("/")

    if args.command == "stage-c-stop":
        if not args.run_id:
            parser.error("--run-id required")
        raise SystemExit(asyncio.run(run_stage_c_stop(base, args.run_id)))

    async def _run() -> int:
        if args.command == "stage-a":
            _, terminal, _ = await drive_run(
                base, STAGE_A_PROMPT, timeout_s=args.timeout, approve_hardware=False
            )
            return 0 if terminal == "completed" else 1
        if args.command == "stage-b":
            _, terminal, _ = await drive_run(
                base, STAGE_B_PROMPT, timeout_s=args.timeout, approve_hardware=True
            )
            return 0 if terminal == "completed" else 1
        _, terminal, _ = await drive_run(
            base,
            STAGE_C_REJECT_PROMPT,
            timeout_s=min(args.timeout, 600.0),
            approve_hardware=True,
            reject_next_hardware=True,
        )
        return 0 if terminal == "stopped" else 1

    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
