#!/usr/bin/env python3
"""Post-build smoke for the release pipeline: prove the built wheels work.

Run against a boardex-runner started from the *installed wheels* (not the
checkout) in fake-bench mode. Asserts:

1. /health answers with the expected contractVersion and runnerKind "real".
2. /bench reports the runner online.
3. A run can be created and its event replay starts with a valid run.created
   (the runner already validates every outbound event against
   packages/contract/json-schema/ at emit time — reaching the stream at all
   means schema validation is wired up in the installed package).

Stdlib-only on purpose so it runs in any venv:

    BOARDEX_CONTRACT_SCHEMA_DIR=... PORT=4390 boardex-runner &
    python servers/scripts/release_smoke.py --base http://127.0.0.1:4390
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from typing import Any

EXPECTED_CONTRACT = "boardex-contract/0.1"


def _get(base: str, path: str) -> Any:
    with urllib.request.urlopen(f"{base}{path}", timeout=10) as res:
        return json.loads(res.read().decode("utf-8"))


def _post(base: str, path: str, body: dict[str, Any]) -> Any:
    request = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as res:
        return json.loads(res.read().decode("utf-8"))


def _wait_for_health(base: str, timeout_s: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            return _get(base, "/health")
        except (urllib.error.URLError, ConnectionError) as err:
            last_error = err
            time.sleep(0.5)
    raise SystemExit(f"runner never became healthy at {base}: {last_error}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:4390")
    parser.add_argument("--startup-timeout", type=float, default=30.0)
    args = parser.parse_args()
    base = args.base.rstrip("/")

    health = _wait_for_health(base, args.startup_timeout)
    print("health:", json.dumps(health))
    if health.get("contractVersion") != EXPECTED_CONTRACT:
        print(f"error: contractVersion != {EXPECTED_CONTRACT}", file=sys.stderr)
        return 1
    if health.get("runnerKind") != "real":
        print("error: runnerKind != real", file=sys.stderr)
        return 1

    bench = _get(base, "/bench")
    if not bench.get("runnerOnline"):
        print("error: /bench says runner offline", file=sys.stderr)
        return 1

    run_id = _post(
        base,
        "/runs",
        {
            "taskPrompt": "Release smoke: BME280 bring-up arc on the fake bench.",
            "boardProfileId": "bp_nucleo_f303re",
        },
    )["runId"]
    print(f"run created: {run_id}")

    deadline = time.monotonic() + 20.0
    events: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        events = _get(base, f"/runs/{run_id}/events?afterSeq=0")
        if events:
            break
        time.sleep(0.25)
    if not events:
        print("error: no events replayed within 20s", file=sys.stderr)
        return 1
    first = events[0]
    if first.get("type") != "run.created" or first.get("seq") != 1:
        print(f"error: unexpected first event: {first}", file=sys.stderr)
        return 1

    print(f"smoke OK: {len(events)} event(s), first = run.created")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
