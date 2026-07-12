---
name: runner-conformance
description: Run servers/boardex-runner (the real §5 runner) and prove conformance — start it in fake-bench or live-bench mode, point the UI and the parameterized mock-runner suite at it via RUNNER_BASE_URL, record a §10.3 fixture, and validate the recording. Use when running the runner, debugging UI-runner integration, re-running conformance after a runner or contract change, or preparing the fixture handoff.
---

# Runner conformance: running and proving `servers/boardex-runner`

The operational counterpart to `contract-bridge-readonly` (which explains the
contract; this explains how to run and prove against it).

## Start the runner

```bash
source .venv/bin/activate            # bootstrap per the pytest-servers skill
pip install -e "servers/boardex-runner[dev]"   # once

boardex-runner                       # fake bench, port 4380
SPEED=8 PORT=4383 boardex-runner     # comfortable UI-demo pacing
FIXTURE=fail boardex-runner          # failing arc -> run.failed terminal
BENCH=real BOARDEX_BENCH_CONFIG=bench.json boardex-runner   # live hardware
```

Environment: `PORT`/`HOST`; `BENCH` = `fake` (default) | `real`; `SPEED` =
fake-bench pacing divisor (virtual clock — timestamps stay realistic);
`PACING` = narrative time dilation (see fixture recording); `FIXTURE=fail`;
`RECORD=<dir>`; `BOARDEX_BENCH_CONFIG` = JSON with `RealBenchConfig` fields
(see `servers/boardex-runner/README.md` for the shape).

Sanity gate: `curl :PORT/health` must return
`{"ok": true, "contractVersion": "boardex-contract/0.1", "runnerKind": "real"}`.

## The three conformance layers (run all after any runner/contract change)

1. **Pytest** (hardware-free, validates every outbound event against
   `packages/contract/json-schema/`):

```bash
pytest servers/boardex-runner/tests
```

2. **The mock runner's integration suite pointed at the runner** (BIBLE §10.4
   item 2). `tools/mock-runner/src/server.test.ts` honors `RUNNER_BASE_URL`;
   mock-only cases (fixture-exact counts, fail-variant/degraded/slow) skip
   automatically:

```bash
SPEED=2000 PORT=4381 boardex-runner &          # fast gates for the suite
RUNNER_BASE_URL=http://127.0.0.1:4381 npm run test -w @boardex/mock-runner
```

   Expected: 8 passed, 4 skipped. Without `RUNNER_BASE_URL` the suite runs
   against the in-process mock (12 passed) — keep that green too.

3. **Live browser run** (§10.4 items 3-5): start the runner (SPEED=8 reads
   well), then

```bash
VITE_RUNNER_URL=http://localhost:4383 npm run dev -w apps/ui
```

   Drive: create run → check every bench-connection box → Approve Plan →
   Approve & Continue at the flash gate → F5 mid-run (state must fully restore
   from the `afterSeq` replay) → kill the WS once (a brief network drop works;
   the UI must reconnect and replay) → Approve Fix Plan → run reaches
   Completed with all checks PASS and Open Report live. Console must stay
   free of app errors.

## Recording the §10.3 fixture

`RECORD=<dir>` tees the FIRST run created after startup to
`<dir>/recorded_run.jsonl` (the `{"delayMs": N, "event": {...}}` line format)
and exports its artifact bodies to `<dir>/artifacts/<artifactId>.<ext>` when
the run terminates.

```bash
RECORD=/tmp/rec SPEED=2000 PACING=17 PORT=4384 boardex-runner &
# drive one run to completion (UI or HTTP), then:
python servers/boardex-runner/scripts/validate_recording.py /tmp/rec
```

`PACING` stretches virtual narrative time so a simulated recording spans the
~9-13 minutes the fixture gate expects; on the live bench (`BENCH=real`) leave
it unset — wall-clock deltas are the recording. `validate_recording.py`
re-implements the contract package's T0.3 fixture gate in Python; a recording
must print `OK` before it is worth handing over.

**Handoff is Kerem's move, not ours**: replacing
`packages/contract/fixtures/bme280_run_001.jsonl` touches UI-owner territory,
and the fail-variant fixture test pins the base story's first 68 events —
swapping only the base file breaks it. Hand the validated recording + artifact
files to the UI owner; do not copy them into `packages/contract/` yourself.

## Ownership guardrails

- The only sanctioned UI-side edit so far is the `RUNNER_BASE_URL` seam in
  `tools/mock-runner/src/server.test.ts` (logged in `docs/decisions.md`,
  2026-07-12). Everything else under `packages/contract`, `apps/ui`,
  `tools/mock-runner` stays read-only.
- A conformance failure is OUR bug until proven otherwise; when it truly is a
  contract gap, propose a BIBLE §5 edit (§10.5 chain) — never emit invented
  events or fields from the runner.
