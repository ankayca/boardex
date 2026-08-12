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
| `BOARDEX_BOARD_PROFILES` | JSON file (a BoardProfile or an array) baked into launch; wins over a saved profile of the same id (`BENCH=fake`/`agent`) |
| `BOARDEX_STATE_DIR` | Where saved board profiles and provider keys rest (default `~/.boardex`) |
| `AGENT_MODELS` | Comma-separated LiteLLM model strings advertised via `/health` `capabilities.models` (`BENCH=agent`; default `openrouter/anthropic/claude-sonnet-4.6`) |
| `AGENT_MAX_TURNS` | Agent turn budget per run (`BENCH=agent`, default 60) |
| `BOARDEX_CONTRACT_SCHEMA_DIR` | Override the JSON Schema location (defaults to repo lookup) |
| `BOARDEX_MCP_BIN_DIR` | Directory containing `boardex-target` / `boardex-logic` (defaults to the running interpreter's `bin` / `Scripts`) |

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

## State on disk

Two things outlive the process, both in `~/.boardex` (`BOARDEX_STATE_DIR` moves
it — one directory per runner on a multi-bench host):

| File | Holds | Mode |
|---|---|---|
| `profiles.json` | Board profiles saved from the dashboard | `0644` |
| `credentials.json` | Provider keys set from the dashboard (see [Provider keys](#provider-keys)) | `0600` |

Both are plain JSON you can read, back up, and delete — deleting the directory
is the reset, and a runner that never saves anything never creates it.
`profiles.json` is an array of wire `BoardProfile` objects, the same shape
`BOARDEX_BOARD_PROFILES` accepts, so a saved set can be handed to another runner
by copying the file.

Writes are atomic (temp file in the same directory, then `os.replace`), so a
crash mid-write leaves the old file whole rather than half a JSON document, and
they are write-through — state is durable as soon as the runner answers, not at
a clean shutdown that a Ctrl-C never reaches. **State files never crash the
runner:** an unreadable, unwritable, or corrupt file costs you what was in it,
never the ability to start. Corrupt JSON is moved aside to
`<name>.corrupt-<timestamp>` with one log line, so nothing is silently deleted.

Board profiles baked into launch with `BOARDEX_BOARD_PROFILES` (and the
`BENCH=real` profile from `bench.json`) win over a saved profile with the same
id: a bench profile has to describe the hardware actually wired to this host, not
whatever a browser last saved under that id. Saved profiles the launch config
says nothing about are still served.

## BENCH=agent

`AgentBench` (RUNNER_AGENT_V0_SPEC v0) replaces the scripted arc with an LLM
tool-use loop per run — one agent session, one fresh bench instance per run —
behind the same engine and wire layer. Highlights:

- **Two phases.** The plan phase binds meta-tools only (`declare_plan`,
  `record_check`, `declare_diagnosis`, `declare_iteration`, `write_report`);
  the MCP servers (`boardex-target` + `boardex-logic` from the running
  interpreter's scripts dir, or `BOARDEX_MCP_BIN_DIR`) are spawned over stdio
  only after `POST /runs/{id}/plan/approve`.
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
  [Provider keys](#provider-keys). Resolved at call time; the key rests only in
  `~/.boardex/credentials.json` (mode `0600`), and nothing key-derived is
  logged, emitted, or written anywhere else.
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

**A key you set survives a restart.** It is written to
`~/.boardex/credentials.json`, mode `0600` — owner-only, the same place and the
same permissions `~/.netrc` and `~/.aws/credentials` have used for decades. Paste
it once. Delete the file (or the whole `~/.boardex` directory) to reset, or press
Remove in the dashboard, which does the same thing for one provider.

**A stored key wins over an exported one at boot**, and the environment seeds
only the providers the file says nothing about. Pasting into the dashboard is the
more recent and more specific act; an exported variable is often inherited from a
shell profile nobody has read in months, and the other order would make the
dashboard silently ineffective for exactly the people who already have the
variable set. What gets written is only what someone deliberately set: an env
seed is never copied to disk, so unsetting the variable and restarting still
removes that key.

Storage changes where the key sleeps and nothing else. Nothing else about this
store moved: `/health`'s masked hint is still the only readable trace, there is
still no read-back route, and nothing on the save path logs key material. If the
file is unwritable the runner says so once and carries on with the key in memory,
and if `~/.boardex/credentials.json` is a **symlink** the runner refuses to read
or replace it — the session works, it just does not persist, because a file whose
mode and directory we did not set cannot be claimed to be owner-only. On Windows
the `0600` is best-effort: the file is created with owner-only intent, but NTFS
ACLs are not POSIX mode bits and the runner does not pretend otherwise.

Not encrypted at rest, deliberately. On a machine where another user can read
your home directory, they can read your keys — encryption there would need a
passphrase on every runner start or a keychain integration per platform, and
both are decisions for the day a shared bench needs auth (see below), not
something to half-build now.

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
