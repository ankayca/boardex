# agent-spike — runner-hosted agent v0, without the wire layer

A Python spike proving the 80% of `docs/RUNNER_AGENT_V0_SPEC.md` that doesn't
need `boardex-runner`: the agent loop, the harness meta-tools, tool-call
interception with the gate-floor amendment, plan-phase tool binding, and
bounds enforcement. Output is a **fixture-format recording**
(`recorded_run.jsonl` + `artifacts/`) so a real agent run replays in the full
UI via the mock runner — zero UI changes, per the spec's acceptance bet.

Not in scope here (spec-side, owned by `servers/boardex-runner`): HTTP/WS
wire layer, approval-by-HTTP, stop-as-hard-cancel, artifact store service.
Approvals are stood in for by a terminal `[y/n]` prompt.

## Install

```sh
# from the repo root, into the repo .venv (where boardex-target/logic live)
.venv/bin/pip install -e "tools/agent-spike[dev]"
```

Dependencies: `litellm` (provider layer), `mcp` (stdio client), `jsonschema`
(contract validation). Python-land only — invisible to the npm workspaces.

## API keys

The primary provider is **OpenRouter**: the default model is
`openrouter/anthropic/claude-sonnet-4.6` and the key comes from
`OPENROUTER_API_KEY`. Any LiteLLM model string works with that provider's
standard env var instead, e.g.:

| `--model` prefix | env var |
|---|---|
| `openrouter/...` | `OPENROUTER_API_KEY` |
| `anthropic/...` | `ANTHROPIC_API_KEY` |
| `openai/...` / `gpt-...` | `OPENAI_API_KEY` |
| `gemini/...` | `GEMINI_API_KEY` |

Startup makes **one probe call**; a missing/invalid key or an unrecognized
model string fails loudly there (exit 2), never mid-run.

**Key handling: env-only, session-scoped.** Keys are read from the process
environment by LiteLLM at call time and nowhere else — the spike has no key
flag, no config file, and never writes, logs, or records a key. Nothing
key-derived reaches `recorded_run.jsonl`, the artifacts, or the model-facing
messages; export the key for the one shell session that runs the CLI
(`export OPENROUTER_API_KEY=...` before `agent-spike ...`) and it dies with
that shell.

## Run

```sh
.venv/bin/agent-spike \
  --task "Change the console output format ... and build it." \
  --repo /abs/path/to/task-firmware \
  --record /abs/path/to/record-dir \
  [--model openrouter/anthropic/claude-sonnet-4.6] \
  [--max-turns 40] [--max-iterations 3]
```

Flow: provider probe → `run.created` → **plan phase** (meta-tools only; the
MCP servers are not even spawned) → `declare_plan` → terminal `[y/n]` plan
gate → MCP servers bind (`.venv/bin/boardex-target` + `boardex-logic` over
stdio, same invocation as `.cursor/mcp.json`) → **execute phase** → …
→ `write_report` → terminal event.

### Safety invariants (harness-enforced)

- **Interception before MCP.** A hardcoded risk list — names `flash_*`,
  `reset_*`, `erase_*`, `recover_*`, `write_*`, the composites
  `run_checkpoint`/`verify_bringup`, plus any tool whose description's summary
  line declares a hardware mutation — parks on `[y/n]` **before** the MCP call.
  No configuration can remove this floor (audit MEDIUM-5 amendment). Rejection
  returns a refusal to the model and ends the run as `stopped`.
- **Fail closed.** Malformed meta-tool payloads are rejected with the schema
  errors; one retry per tool, then the run aborts as `failed`.
- **Bounds.** `--max-turns` and `--max-iterations` are harness counters;
  exceeding either ends the run `failed` after a partial-report attempt.
- **Evidence law.** `record_check` requires an `artifactId` that exists in
  this run; the run cannot complete with unresolved or failing checks.

### Harness-provided tools (deviation, by necessity)

`boardex-target`/`boardex-logic` expose **no file editing** (verified; the
runner's bench is "no code editing" by design — the Cursor predecessor got
file tools from Cursor itself). The spike therefore binds three repo-scoped
workspace tools: `list_files`, `read_file`, `write_file(path, content,
reason)`. Each `write_file` records a contract `code_diff` artifact
(`{files: [{path, reason, diff}]}`). These stand in for the workspace layer
AgentBench will need; they are **not** part of the MCP servers.

One more harness convention: every tool accepts an optional `_plan_index`
the model uses to bind the step to its declared plan row; the harness strips
it before dispatch.

## Recording format

`<record>/recorded_run.jsonl` — one `{"delayMs": N, "event": {...}}` per line
(BIBLE §5.5): gapless `seq` from 1, envelope `ts`, `delayMs` wall-clock gap
capped at 20 000 ms, every line validated against
`packages/contract/json-schema/events.schema.json` **at write time**.
Artifacts land at `<record>/artifacts/<artifactId><ext>` with the mock
runner's extension-by-kind convention and honest `sizeBytes`.

## Replay a recording in the full UI

```sh
# terminal 1 — mock runner replaying the recording (additive FIXTURE_FILE knob)
FIXTURE_FILE=/abs/path/to/record-dir/recorded_run.jsonl npm run start -w @boardex/mock-runner

# terminal 2 — the UI
npm run dev -w @boardex/ui
```

Open the UI, create a run — the recording replays with the real pacing,
pausing at the plan gate and every approval exactly as it did live. Add
`SPEED=10` to terminal 1 to fast-forward. The recording's `boardProfileId`
must be one the replaying runner can resolve (the spike records the mock's
canned `bp_nucleo_f303re`); the UI blocks plan approval on an unresolvable
profile.

To produce a fresh recording of the tier-1 task first:

```sh
export OPENROUTER_API_KEY=...   # session-scoped; see Key handling above
cp -r examples/firmware firmware/agent-spike-workspace
.venv/bin/agent-spike \
  --task 'Change the console output format in the reference firmware to print PRESSURE=<p> alongside TEMP/HUM, and build it. Bench note: the cross toolchain is at <abs-path>/bin/ — build via build_firmware with command "make CROSS=<abs-path>/bin/arm-none-eabi-". No board is attached.' \
  --repo "$PWD/firmware/agent-spike-workspace" \
  --record "$PWD/tools/agent-spike/records/run$(date +%s)"
```

Give the toolchain path in the task (board profiles carry `buildCommand` in
the real runner); without it the agent cannot discover host paths and the
run ends as an honest build failure.

## Tests

```sh
cd tools/agent-spike && ../../.venv/bin/python -m pytest
```

Covers: meta-tool payload validation (valid / malformed / one-retry /
two-strikes-abort), interception firing **before** MCP invocation with
approve/reject/ungated paths (mocked MCP host), fixture-format validity of a
synthetic run (line schema, seq, ts, delayMs cap, artifact sizeBytes, seal
rules, §5.7 transition guard), and bounds enforcement. The live model run is
the acceptance, not a CI test.
