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

# Agent bench (LLM tool-use loop over the MCP servers; needs the agent extras):
pip install -e "servers/boardex-runner[agent]"
BENCH=agent AGENT_MODELS=openrouter/anthropic/claude-sonnet-4.6 boardex-runner
# ...then set the provider key from the dashboard (see Provider keys below),
# or export OPENROUTER_API_KEY before launching if you prefer the shell.
```

Point the UI at it:

```bash
VITE_RUNNER_URL=http://localhost:4380 npm run dev -w apps/ui
```

## Environment

| Variable | Meaning |
|---|---|
| `PORT` / `HOST` | Listen address (default `127.0.0.1:4380`) |
| `BENCH` | `fake` (default), `real` or `agent` |
| `SPEED` | Fake-bench pacing divisor (virtual clock) |
| `FIXTURE=fail` | Fake bench replays the failing arc |
| `RECORD=<dir>` | Tee the first run to `<dir>/recorded_run.jsonl` + `artifacts/` (§10.3 fixture format) |
| `BOARDEX_BENCH_CONFIG` | JSON file with `RealBenchConfig` fields (`BENCH=real`) |
| `BOARDEX_BOARD_PROFILES` | JSON file (a BoardProfile or an array) baked in at launch so profiles survive restarts (`BENCH=fake`/`agent`) |
| `AGENT_MODELS` | Comma-separated LiteLLM model strings advertised via `/health` `capabilities.models` (`BENCH=agent`; default `openrouter/anthropic/claude-sonnet-4.6`) |
| `AGENT_MAX_TURNS` | Agent turn budget per run (`BENCH=agent`, default 60) |
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

## BENCH=agent

`AgentBench` (RUNNER_AGENT_V0_SPEC v0) replaces the scripted arc with an LLM
tool-use loop per run — one agent session, one fresh bench instance per run —
behind the same engine and wire layer. Highlights:

- **Two phases.** The plan phase binds meta-tools only (`declare_plan`,
  `record_check`, `declare_diagnosis`, `declare_iteration`, `write_report`);
  the MCP servers (`<checkout>/.venv/bin/boardex-target` + `boardex-logic`
  over stdio) are spawned only after `POST /runs/{id}/plan/approve`.
- **Gate floor (audit MEDIUM-5 amendment).** `flash_*`/`reset_*`/`erase_*`/
  `recover_*`/`write_*`-prefixed tools, the composites `run_checkpoint`/
  `verify_bringup`, and any tool whose description's summary line declares a
  hardware mutation park on `approval.requested` BEFORE the MCP invocation.
  No configuration — profile, bench config, or env — can remove this floor;
  a falsey `safety.flashRequiresApproval` still gates.
- **Stop is a hard cancel.** `POST /stop` seals the log immediately and
  cancels the agent task at its next await point.
- **Harness-owned file tools.** `list_files`/`read_file`/`write_file`, scoped
  to the run profile's `repoPath` (which must exist on this host); every
  `write_file` records a contract `code_diff` artifact.
- **Bounds.** `AGENT_MAX_TURNS`, `safety.maxIterations` (counted on
  `declare_iteration`) and a 3-turn idle stall are harness counters; a
  malformed meta-tool payload gets one retry, then the run fails closed.
- **Keys.** Set from the dashboard or from the environment — see
  [Provider keys](#provider-keys). Resolved at call time; nothing key-derived is
  logged, stored on disk, or emitted.
- **Model selection.** `/health` advertises `capabilities.models` from
  `AGENT_MODELS`; `CreateRun.model` must be in that list (else 409) and is
  echoed onto `Run.model`; absent, the first listed model is used.

## Provider keys

**The dashboard is the primary path.** Settings → Provider keys lists every
provider this runner can hold a key for (derived from `AGENT_MODELS`), shows
whether each is configured, and lets you paste or remove one. Nobody has to open
a terminal to get a first run going, and a key pasted mid-session takes effect on
the next run — no restart.

**The environment is the fallback**, unchanged. Export the provider-standard
variable (`OPENROUTER_API_KEY` for `openrouter/*`, `ANTHROPIC_API_KEY`, ...)
before launching and that provider boots configured; the dashboard shows it as
such rather than offering to set what is already set. A key set in the dashboard
takes precedence over the environment for as long as it is stored.

**Remove discards the dashboard's key, not the environment's.** If the provider's
variable was exported at launch, Remove reverts to it: the provider goes on
showing as configured, with the exported key's hint, and runs go on using it —
that is the truth, not a stale badge. Stopping spend on an env-provided key means
unsetting the variable and restarting the runner. That is your launch
configuration, and the dashboard deliberately has no authority over it: a web
page should not be able to rewrite how the process was started.

**Storage is in-memory and dies with the process.** A restart clears anything set
from the dashboard — paste it again, or export the variable to have it survive.
That is deliberate for v0: a key that outlives the process has to rest somewhere
on disk, and that is a decision to make on purpose, not a side effect.

The store is **write-only**: no route serves key material back. `GET /health`
advertises presence and a masked hint (last four characters, and nothing at all
for a key short enough that four characters would be most of it) under a
non-contract `credentials` field, which is also what the UI feature-detects on.
Both write routes — `PUT /credentials`, `DELETE /credentials/{provider}` —
require a loopback `Host` and, when the browser sends one, a loopback `Origin`,
so a page that rebinds its own hostname to `127.0.0.1` cannot set or clear a key.

One accepted trade in that advertisement: when a key comes from the environment,
`/health` now exposes its last four characters, which before this feature had no
HTTP trace at all. That is the cost of the dashboard being able to tell you
*which* key is active instead of merely that one is, and it is accepted
deliberately — but it is new exposure on an unauthenticated route, so it is
stated rather than buried.

**Not yet solved: shared benches, and spend.** The runner has no auth (single-user
MVP), so anyone who can reach it on the network can set or replace the key — fine
on your own machine, not fine on a bench several people share. The Host/Origin
guard is narrower than it may look, too: it stops a rebound browser page from
writing keys, but that page can still `POST /runs` and approve a plan, and a run
started that way spends whatever key is active and drives the hardware. Closing
that means extending the guard to the run-starting and approval routes, which are
contract routes with external-runner conformance behind them — a decision for the
backend owner, not something this feature should change on its own.

## Tests

Hardware-free, like every other server suite:

```bash
pytest servers/boardex-runner/tests
```

The suite validates every emitted event against the contract schema, the §5.7
transition graph, approval blocking, stop semantics, replay, 404/409, and
artifact serving. See also `.cursor/skills/runner-conformance` for pointing
the mock runner's integration suite and the UI at this service.
