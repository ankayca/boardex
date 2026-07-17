# AgentBench Port Report — `agent/bench-port`

Date: 2026-07-13 · Branch: `agent/bench-port` (pushed to origin, **not merged** — the
backend owner's review gates the merge) · Commits: `73fa483 feat(runner)`, `0351e41 docs`

**TLDR:** The agent-spike loop is ported into `servers/boardex-runner` as a third
bench (`BENCH=agent`), married to the existing engine seams with a minimal diff.
48 pytest green (33 pre-existing + 15 new), `npm run verify` exit 0, zero changes
in `apps/ui` or `packages/contract`. The live tier-1 PRESSURE acceptance is
**stopped at readiness**: `OPENROUTER_API_KEY` is not in the environment (and the
persistent `ANTHROPIC_API_KEY` has zero credits since 2026-07-13).

## New dependencies (declared per CLAUDE.md rule 2)

All confined to a new optional `[agent]` extra in `servers/boardex-runner/pyproject.toml`
and imported lazily — `BENCH=fake|real` deployments and CI install none of them; the
test suite runs entirely without them:

- `litellm>=1.40` — the provider layer (any LiteLLM model string; keys via
  provider-standard env vars).
- `fastapi>=0.100`, `orjson>=3.9` — litellm lazy-imports its proxy path on any
  tool-calling turn; without these the first such turn crashes on ModuleNotFoundError.
- `mcp>=1.0` — stdio client to boardex-target / boardex-logic.

## What landed

### New modules (flat siblings, matching the spike for reviewability)

| File | Role |
|---|---|
| `agent_bench.py` | `AgentBench` (per-run config/resource carrier) + `AgentRunEngine` (the loop) |
| `interception.py` | The gate-floor classifier (§3.1 amendment / audit MEDIUM-5) — standalone on purpose |
| `meta_tools.py` | The five meta-tool schemas (`declare_plan`, `record_check`, `declare_diagnosis`, `declare_iteration`, `write_report`) |
| `workspace.py` | Harness-owned repo-scoped file tools; `write_file` emits a `code_diff` artifact |
| `provider.py` | LiteLLM layer; keys env-only, never logged/stored/emitted |
| `mcp_host.py` | Stdio client host; servers spawned only after plan approval |
| `prompts.py` | System prompt, fumble-list encodings verbatim from the spike |

### The wire marriage (the 20% that replaced the spike's stdio stand-ins)

- `declare_plan` → `plan_ready` transition → `run.plan_generated` → parks on the
  engine's **existing** plan-approval future, released by `POST /runs/{id}/plan/approve`.
- Every intercepted hardware call parks on the **existing** `_approval_gate`
  (`approval.requested` → HTTP resolution). Rejection ends the run via the engine's
  own stopped path; the MCP tool is provably never invoked.
- All events flow through `EventLog` (append-path schema validation comes free);
  artifacts through `ArtifactStore`; the RECORD tee works unchanged.
- `stop()`: the base path seals the log and emits the terminal pair, then the agent
  task is cancelled at its next await — never "after the current turn finishes."
  A stopped run emits nothing further (sealed-log guarantee, tested).
- Engine seams touched, and how little: `engine.py` gained only an optional `model`
  kwarg (echoed on the Run entity); `server.py` gained `engine_cls`/`models` on
  `RunnerApp`, model validation on POST /runs, capabilities on /health, and the
  `BENCH=agent` branch in `state_from_env()`; `contract.py` gained `definition_errors()`.
  Gates, log, store, recorder, stop are used as-is. FakeBench and RealBench untouched;
  `BENCH=fake` remains the default.

### Safety invariants (harness-enforced, never prompt-enforced)

- **Gate floor, non-removable:** `flash_*`/`reset_*`/`erase_*`/`recover_*`/`write_*`
  prefixes, the composites `run_checkpoint`/`verify_bringup`, plus a first-line
  description scan for mutation verbs. No profile, bench config, or env can remove
  it — a falsey `safety.flashRequiresApproval` still gates (MED-5 branch, now tested).
- **Plan-phase binding:** meta-tools only until plan approval; the MCP servers are
  not even spawned before it.
- **Bounds:** `AGENT_MAX_TURNS` (default 40), `profile.safety.maxIterations`
  (harness-counted on `declare_iteration`), 3-turn idle stall. Exceeding → graceful
  `run.failed` with a partial-report attempt.
- **Fail closed:** malformed meta-tool payloads get one retry then abort the run as
  failed; `record_check` enforces the evidence law (artifactId must resolve within
  the run); MCP transport errors surface as visibly failed steps.
- **Per-run instances:** one `AgentBench` per run (audit HIGH-1's singleton mistake
  structurally avoided); `/bench` serves a static snapshot with no devices — nothing
  scans on the event loop (HIGH-2 avoided for this bench).

### The audit's five breaking assumptions, resolved (decisions.md 2026-07-13)

1. **Step ids seq-derived:** `st_{kind}_{suffix}_{seq}` — N flashes never collide
   (the scripted `st_{kind}_iter{n}` scheme would).
2. **planIndex:** stays required on the wire (contract unchanged); bound via the
   harness-only optional `_plan_index` tool param, stripped before MCP dispatch,
   clamped to the declared plan, defaulting to the last bound row.
3. **N approval gates per iteration is normal** — approval ids reuse the engine's
   seq-derived scheme; tested with two gated flashes in one iteration.
4. **No discrete evaluate stage** — `check.evaluated` fires whenever the agent
   records.
5. **Iteration segmentation = `declare_iteration`**, harness-counted against the
   profile bound.

### Model plumbing

`AGENT_MODELS` (comma-separated, default `openrouter/anthropic/claude-sonnet-4.6` —
the spike's tested model) → `/health` `capabilities.models`. `CreateRun.model`
outside the list → 409 `{error}` (no `currentStatus` — there is no run whose status
could be reported; logged as a deliberate reading in decisions.md). The model
actually used (chosen, or first-listed default) is echoed onto `Run.model`. Keys via
provider-standard env vars only.

### Docs

- BIBLE §10.0: three sentences updated — orchestrator is built, AgentBench runs the
  loop behind harness-enforced gates alongside the scripted benches, MCP surface
  spawned per run after plan approval. No restructure.
- decisions.md: three entries (the port; file-tools-harness-owned ruling; the
  id/planIndex/evaluate/iteration resolutions).
- Runner README: `BENCH=agent` run instructions, env table rows, and a highlights
  section (gate floor, key handling, bounds, model selection).

## Tests (his pytest conventions; all LLM-free — CI never needs an API key)

`tests/test_agent_bench.py` + `tests/test_agent_http.py` + agent helpers appended to
`tests/conftest.py`. A scripted provider serves canned tool-call turns and a fake
tool host stands in for MCP, driving the real `AgentRunEngine` + HTTP/WS wire layer:

- Deterministic loop end-to-end: plan → gate park → approve → execution → checks →
  report → `run.completed` — at engine level (fixed run id, so the scripted
  `record_check` can cite a real artifact id) and over real HTTP+WS (plan approval
  and the flash gate resolved by POST).
- Rejection path: tool never invoked, run stopped, `approval.resolved: rejected`.
- **Gate floor on a falsey `flashRequiresApproval` profile: approval STILL
  requested** — the MED-5 branch, finally tested.
- Stop mid-turn (hanging provider): terminal pair emitted immediately, agent task
  cancelled, sealed log emits nothing after.
- Step-id uniqueness under repeated same-kind calls + two gates in one iteration.
- Malformed meta-tool: one visible retry (schema errors returned to the model),
  second offense → `run.failed`.
- Evidence law: a check citing a nonexistent artifact never emits `check.evaluated`.
- Iteration/turn/stall bounds; MCP transport error as a visible `step.failed`;
  model-selection validation (409 + echo) and `/health` capabilities over HTTP.
- Every emitted event is contract-valid: the engine's append-path validation runs in
  every test, and streams are additionally checked with the suite's
  `assert_wire_conformant` (gapless seq, §5.7 transitions, terminal-is-terminal).

Results: **pytest 48 passed** · **`npm run verify` exit 0** (one pre-existing UI
lint warning, no errors) · **zero changes in `apps/ui` or `packages/contract`**.

## Acceptance status: STOPPED AT READINESS

Readiness proven without a key: `BENCH=agent AGENT_MODELS=... PORT=4381
boardex-runner` boots and serves contract-valid `/health` (capabilities advertised)
and `/bench`. The live leg needs `OPENROUTER_API_KEY` exported in the serving shell —
it is absent, so per the task instruction the run was not attempted. To execute it:

```bash
export OPENROUTER_API_KEY=...           # session-scoped, per house key policy
cp -r examples/firmware firmware/agent-bench-workspace
BENCH=agent AGENT_MODELS=openrouter/anthropic/claude-sonnet-4.6 \
  PORT=4380 RECORD=$PWD/records/agent-run-$(date +%s) .venv/bin/boardex-runner
# then: VITE_RUNNER_URL=http://localhost:4380 npm run dev -w @boardex/ui
```

Note for the live run: save a board profile whose `repoPath` points at the copied
workspace — the canned Nucleo profile's `/bench/firmware/...` path does not exist on
this host, and the run would (correctly, visibly) fail at start. Drive the tier-1
PRESSURE prompt through the composer; the RECORD tee's output must pass the fixture
validation test unmodified; any needed UI edit is a contract finding to report, not
absorb.

## PR description highlights (for the backend owner)

1. **The safety middleware, for his signature:** `interception.py` — the hardcoded
   gate floor resolving his audit's MEDIUM-5; deliberately a standalone ~45-line
   file so it can be reviewed in isolation.
2. **Every engine seam touched, and how little** (table above): one optional kwarg
   on `RunEngine`, additive params on `RunnerApp`, one helper in `contract.py`.
   His gates/log/store/recorder/stop are consumed, not modified.
3. **The five assumption resolutions**, each recorded in decisions.md.
4. **One honest gap flagged, not absorbed:** a plan-phase abort (agent never plans /
   malformed twice) emits `run.failed` while status is `planning` — an edge §5.7
   does not draw. His existing catch-all does the same today for a `bench.plan()`
   crash, so the ruling is his: add the edge via §10.5, or define a different
   terminal for pre-plan failure.
5. **Per-run bench instances + static `/bench` snapshot** structurally avoid HIGH-1
   and HIGH-2 for this bench; FakeBench/RealBench and `BENCH=fake` default untouched.
