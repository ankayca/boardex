#!/usr/bin/env python3
"""Drive one scripted run against a live boardex-runner (BENCH=real).

Hardware-free pytest stays in tests/; this script is for manual bench
integration. Start the runner first, then:

    BENCH=real BOARDEX_BENCH_CONFIG=bench.live.json PORT=4385 boardex-runner &
    python servers/boardex-runner/scripts/live_run_smoke.py --base http://127.0.0.1:4385

Exits 0 when the run reaches run.completed; 1 on run.failed/stopped or timeout.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

import aiohttp

TERMINAL = {"completed", "failed", "stopped"}
POLL_S = 0.25


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
    resolved = {
        e["payload"]["approvalId"] for e in events if e["type"] == "approval.resolved"
    }
    return next((a for a in requested if a not in resolved), None)


def _check_verdicts(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for event in events:
        if event["type"] == "check.evaluated":
            checks.append(event["payload"]["check"])
    return checks


async def drive(base: str, timeout_s: float) -> int:
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{base}/health") as res:
            health = await res.json()
            print("health:", json.dumps(health, indent=2))
            if health.get("runnerKind") != "real":
                print("error: expected runnerKind=real", file=sys.stderr)
                return 1

        async with session.get(f"{base}/bench") as res:
            bench = await res.json()
            print("bench devices:")
            for device in bench.get("devices", []):
                print(f"  - {device['id']}: {device['state']} ({device['kind']})")

        async with session.post(
            f"{base}/runs",
            json={
                "taskPrompt": "RTT smoke on Nucleo-F303RE",
                "boardProfileId": "bp_nucleo_f303re",
            },
        ) as res:
            if res.status != 200:
                body = await res.text()
                print(f"create run failed: {res.status} {body}", file=sys.stderr)
                return 1
            run_id = (await res.json())["runId"]
        print(f"run_id: {run_id}")

        resolved: set[str] = set()
        deadline = asyncio.get_event_loop().time() + timeout_s
        events: list[dict[str, Any]] = []

        while asyncio.get_event_loop().time() < deadline:
            async with session.get(f"{base}/runs/{run_id}/events?afterSeq=0") as res:
                events = await res.json()
            status = _status_of(events)
            print(f"status: {status} (seq {events[-1]['seq'] if events else 0})")

            if status in TERMINAL:
                break
            if status == "plan_ready" and "__plan__" not in resolved:
                async with session.post(f"{base}/runs/{run_id}/plan/approve") as res:
                    if res.status == 204:
                        resolved.add("__plan__")
                        print("approved plan")
            pending = _pending_approval(events)
            if pending and pending not in resolved:
                async with session.post(
                    f"{base}/runs/{run_id}/approvals/{pending}",
                    json={"status": "approved"},
                ) as res:
                    if res.status == 204:
                        resolved.add(pending)
                        print(f"approved {pending}")
            await asyncio.sleep(POLL_S)
        else:
            print(f"timeout after {timeout_s}s", file=sys.stderr)
            return 1

        terminal = _status_of(events)
        print(f"terminal: {terminal}")
        for check in _check_verdicts(events):
            print(
                f"  check {check.get('requirementId')}: {check.get('verdict')} "
                f"({check.get('description')})"
            )
        return 0 if terminal == "completed" else 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base",
        default=os.environ.get("RUNNER_BASE_URL", "http://127.0.0.1:4380"),
        help="Runner HTTP base URL (default: RUNNER_BASE_URL or :4380)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=600.0,
        help="Wall-clock seconds to wait for a terminal state (default 600)",
    )
    args = parser.parse_args()
    raise SystemExit(asyncio.run(drive(args.base.rstrip("/"), args.timeout)))


if __name__ == "__main__":
    main()
