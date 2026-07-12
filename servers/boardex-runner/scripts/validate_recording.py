#!/usr/bin/env python3
"""Pre-flight a §10.3 recording against the contract package's fixture gate.

Re-implements the T0.3 acceptance checks (packages/contract/src/fixture.test.ts,
base-fixture describe block) in Python so a bench recording can be validated
before it is handed to the UI owner to replace the authored fixture:

  - every line is {"delayMs": 0..20000, "event": <schema-valid event>}
  - seq gapless from 1, timestamps non-decreasing, ~9-13 min narrative span
  - reduces to completed: 2 approvals approved, iteration 2, 3 passing checks,
    6-step plan, a diagnosis, and 2 failed check verdicts along the way
  - every check's artifactId announced; every artifact has a file named
    <id>.<ext> in <dir>/artifacts with matching sizeBytes
  - structured artifact bodies validate against artifacts.schema.json

Usage: python validate_recording.py <dir-with-recorded_run.jsonl> [name]
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

from boardex_runner.contract import validate_artifact_content, validate_event

MAX_DELAY_MS = 20_000


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    raise SystemExit(1)


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    directory = Path(sys.argv[1])
    name = sys.argv[2] if len(sys.argv) > 2 else "recorded_run"
    path = directory / f"{name}.jsonl"
    artifacts_dir = directory / "artifacts"

    lines = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    if len(lines) <= 50:
        fail(f"only {len(lines)} events; the gate expects a plausible story (>50)")

    events = []
    for i, line in enumerate(lines):
        if set(line) != {"delayMs", "event"}:
            fail(f"line {i + 1}: keys {sorted(line)} != ['delayMs', 'event']")
        if not isinstance(line["delayMs"], int) or not 0 <= line["delayMs"] <= MAX_DELAY_MS:
            fail(f"line {i + 1}: delayMs {line['delayMs']} outside 0..{MAX_DELAY_MS}")
        validate_event(line["event"])
        events.append(line["event"])

    for i, event in enumerate(events):
        if event["seq"] != i + 1:
            fail(f"seq gap at index {i}: {event['seq']} != {i + 1}")
    times = [datetime.fromisoformat(e["ts"].replace("Z", "+00:00")) for e in events]
    for a, b in zip(times, times[1:]):
        if b < a:
            fail("timestamps decrease")
    span_min = (times[-1] - times[0]).total_seconds() / 60
    if not 9 < span_min < 13:
        fail(f"narrative span {span_min:.1f} min outside the gate's 9-13 min window")

    if events[0]["type"] != "run.created":
        fail("first event is not run.created")
    if events[-1]["type"] != "run.completed":
        fail(f"terminal event is {events[-1]['type']}, not run.completed")

    plan = next(e for e in events if e["type"] == "run.plan_generated")
    if len(plan["payload"]["plan"]) != 6:
        fail(f"plan has {len(plan['payload']['plan'])} steps, gate expects 6")

    approvals = [e for e in events if e["type"] == "approval.requested"]
    resolutions = [e for e in events if e["type"] == "approval.resolved"]
    if len(approvals) != 2 or len(resolutions) != 2:
        fail(f"{len(approvals)} approvals / {len(resolutions)} resolutions, gate expects 2/2")
    if not all(r["payload"]["status"] == "approved" for r in resolutions):
        fail("not every approval resolved approved")

    iterations = [e for e in events if e["type"] == "run.iteration_started"]
    if len(iterations) != 1 or iterations[0]["payload"]["iteration"] != 2:
        fail("gate expects exactly one run.iteration_started with iteration 2")
    if "address" not in iterations[0]["payload"]["reason"].lower():
        fail("iteration reason does not mention the address root cause")

    checks = [e["payload"]["check"] for e in events if e["type"] == "check.evaluated"]
    latest = {c["requirementId"]: c for c in checks}
    if sorted(latest) != ["device_ack", "i2c_clock", "serial_output"]:
        fail(f"final requirements {sorted(latest)} != the BME280 story's three")
    if not all(c["verdict"] == "pass" for c in latest.values()):
        fail("not every final check passes")
    if sum(1 for c in checks if c["verdict"] == "fail") != 2:
        fail("gate expects exactly 2 failed verdicts along the way")
    if not any(e["type"] == "diagnosis.created" for e in events):
        fail("no diagnosis.created")

    metas = [e["payload"]["artifact"] for e in events if e["type"] == "artifact.created"]
    ids = {m["id"] for m in metas}
    for check in latest.values():
        if check["artifactId"] not in ids:
            fail(f"check {check['requirementId']} cites unannounced {check['artifactId']}")
    files = {f.name.rsplit(".", 1)[0]: f for f in artifacts_dir.iterdir()}
    structured = {"protocol_decode", "code_diff", "timing_measurement"}
    for meta in metas:
        file = files.get(meta["id"])
        if file is None:
            fail(f"no artifact file for {meta['id']}")
        if file.stat().st_size != meta["sizeBytes"]:
            fail(f"{meta['id']}: file {file.stat().st_size} B != sizeBytes {meta['sizeBytes']}")
        if meta["kind"] in structured:
            validate_artifact_content(meta["kind"], json.loads(file.read_text()))

    print(
        f"OK: {len(events)} events, span {span_min:.1f} min, "
        f"{len(metas)} artifacts, 3/3 final checks pass."
    )


if __name__ == "__main__":
    main()
