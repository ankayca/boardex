# boardex-runner

The Boardex orchestrator: a scripted run engine over the MCP tool layer
(`boardex-target`, `boardex-logic`) exposing the BIBLE §5 wire contract —
HTTP command API + WebSocket event streams — with `runnerKind: "real"`.

The UI never sees MCP; this service translates bench execution into the §5.2
event catalog with gapless per-run `seq`, artifacts by reference, blocking
approvals, fast stop, and HTTP replay via `afterSeq`. Every outbound event is
validated against `packages/contract/json-schema/events.schema.json` at emit
time; a non-conforming event never reaches the wire.

## Run it

```bash
pip install -e "servers/boardex-runner[dev]"

# Hardware-free simulated bench (default), port 4380:
boardex-runner

# Faster simulated pacing (virtual clock — timestamps stay realistic):
SPEED=50 PORT=4380 boardex-runner

# Fail-variant story (iteration 2 fails again -> run.failed):
FIXTURE=fail boardex-runner

# Real bench (pyOCD probe + optional sigrok analyzer):
BENCH=real BOARDEX_BENCH_CONFIG=bench.json boardex-runner
```

Point the UI at it:

```bash
VITE_RUNNER_URL=http://localhost:4380 npm run dev -w apps/ui
```

## Environment

| Variable | Meaning |
|---|---|
| `PORT` / `HOST` | Listen address (default `127.0.0.1:4380`) |
| `BENCH` | `fake` (default) or `real` |
| `SPEED` | Fake-bench pacing divisor (virtual clock) |
| `FIXTURE=fail` | Fake bench replays the failing arc |
| `RECORD=<dir>` | Tee the first run to `<dir>/recorded_run.jsonl` + `artifacts/` (§10.3 fixture format) |
| `BOARDEX_BENCH_CONFIG` | JSON file with `RealBenchConfig` fields (`BENCH=real`) |
| `BOARDEX_CONTRACT_SCHEMA_DIR` | Override the JSON Schema location (defaults to repo lookup) |

A `bench.json` for `BENCH=real` carries the wire `BoardProfile` plus bench
wiring, e.g.:

```json
{
  "profile": { "id": "bp_nucleo_f303re", "name": "Nucleo-F303RE", "...": "..." },
  "device_id": "pyocd:stlink:<serial>",
  "target": "stm32f303retx",
  "project_dir": "examples/firmware/rtt-f303re",
  "rtt_pattern": "TEMP=\\d+\\.\\d HUM=\\d+\\.\\d",
  "logic_analyzer_id": "sigrok:kingst-la2016:conn=3.12",
  "i2c_channel_map": { "scl": 0, "sda": 1 },
  "i2c_address_7bit": 118
}
```

## Tests

Hardware-free, like every other server suite:

```bash
pytest servers/boardex-runner/tests
```

The suite validates every emitted event against the contract schema, the §5.7
transition graph, approval blocking, stop semantics, replay, 404/409, and
artifact serving. See also `.cursor/skills/runner-conformance` for pointing
the mock runner's integration suite and the UI at this service.
