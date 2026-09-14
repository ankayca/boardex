# Runner-Hosted Agent v0 — Design Spec

Status: PROPOSAL for joint review (the product owner drafts, the backend owner owns the build — `servers/boardex-runner`).
Predecessor proof: the Cursor-hosted BMP180 run (agent + MCP tools, no terminal, real bench).
Goal: move that harness into `boardex-runner` so `POST /runs` produces a real agent run through the existing UI, emitting the §5 event stream. **Zero UI changes expected** — that is the acceptance test of six sprints of contract discipline.

---

## 1. Architecture (one paragraph)

`boardex-runner` gains an `AgentBench` alongside `FakeBench`, selected by `BENCH=agent`. It reuses the existing engine/wire layer (seq, WS, artifact store, replay — all already built for FakeBench). AgentBench runs one **agent session per run**: an LLM tool-use loop (Anthropic Messages API or Agent SDK; model chosen per §5's v2.1 `CreateRun.model`, advertised via `capabilities.models`) whose tools are (a) the boardex-target and boardex-logic MCP tools, connected via MCP client, and (b) a small set of **harness meta-tools** (below) that exist so structured product events are *emitted by tool call*, never parsed out of prose.

## 2. The two phases

**Plan phase.** First agent turn runs with meta-tools only (no hardware tools bound). System prompt instructs: read the task prompt + board profile (+ profile documents when present), then call `declare_plan(steps[], risk_summary, checks[])`. The harness maps this to `run.plan_generated` (+ registers the declared `MeasurementCheck` expectations) and **parks the session** until `POST /runs/{id}/plan/approve` arrives. No hardware tool is even bound before plan approval — unapproved hardware access is unrepresentable, not just forbidden.

**Execute phase.** Hardware tools bind. The loop runs: each tool call becomes a `RunStep` (`step.started` on invocation, `step.completed/failed` on the tool's `OperationResult.verdict`), tool stdout/log output routes to the matching `step.log` stream (`build`/`flash`/`serial`/`rtt`), agent text between tool calls routes to stream `agent`, and byte outputs (captures, decodes, diffs, logs) persist to the ArtifactStore → `artifact.created`.

## 3. The safety invariants (harness-enforced, never prompt-enforced)

1. **Approval gate = tool-call interception.** A configured risk-tier list (v0: `flash_*`, `reset_*`, and anything the profile's safety block names) is intercepted *before* MCP invocation → `approval.requested` (proposal composed from the agent's own stated intent + files changed) → session parked → resume on approve; on reject → the tool call returns a refusal result to the agent and the harness ends the run (`run.stopped`).
2. **Stop is a hard cancel.** `POST /stop` cancels the agent task at the next await point, runs the bench-safe halt (target halt via pyOCD), emits `run.stopped`. Never "after the current turn finishes."
3. **Iteration bound.** `BoardProfile.safety.maxIterations` is a harness counter (incremented on `declare_iteration`, below), not a prompt suggestion. Exceeding it force-terminates with `run.failed` + a final report attempt.
4. **Budget bound.** Max agent turns and max token spend per run (env-configured); exceeding → graceful `run.failed` with partial evidence retained.
5. **Fail closed.** Unknown tool call, malformed meta-tool payload, MCP transport error → the step fails visibly; the harness never guesses.

## 4. Harness meta-tools (the structured-output trick)

The agent is given these alongside the hardware tools; each maps 1:1 to a wire event, which kills prose-parsing:

| meta-tool | maps to |
|---|---|
| `declare_plan(steps, risk_summary, checks)` | `run.plan_generated` + check registration |
| `record_check(requirementId, actual, verdict, artifactId, sourceRef?/sourceDoc?)` | `check.evaluated` (harness validates artifactId resolves — the evidence law lives here too) |
| `declare_diagnosis(failedCheckIds, hypotheses, proposedFix)` | `diagnosis.created` (+ the subsequent fix approval is the next intercepted risky call) |
| `declare_iteration(reason)` | `run.iteration_started` (harness increments + enforces the bound) |
| `write_report(markdown)` | `report_md` artifact + `run.completed` when all registered checks pass or user-accepted |

System prompt states plainly: hardware claims without a `record_check` citing an artifact do not count; the run cannot complete with unresolved checks. (The agent is being held to the same evidence law as the UI.)

## 5. v0 cuts (explicit, so scope holds)

Single board profile; the risk-tier list is static config; no RTT requirement (stream supported if tools emit it); diagnosis = one `declare_diagnosis` before any fix attempt (prompt-encouraged, not schema-forced); no parallel runs (one agent session at a time); checks limited to what `record_check` carries; no source-excerpt emission (his deferral stands — `sourceDoc` may cite profile documents when the agent read them). RECORD tee works unchanged → every real agent run is automatically a §10.3 fixture candidate.

## 6. Acceptance (the milestone's definition of done)

The BMP180 prompt, pasted into the Boardex composer against a real bench profile, produces: a plan the user approves in the UI → an intercepted flash approval → live streams in the workspace → `record_check`-backed verdicts in the evidence band → a written report — with `npm run smoke`-grade UI behavior throughout (reload mid-run restores; stop works). The Cursor transcript of the original BMP180 session is the design input for tuning the step granularity and system prompt — attach it to this spec's PR.

## 7. Open questions

1. MCP client in-process (Python SDK) vs subprocess — what do his servers expect today?
2. Which tool families beyond flash/reset belong on the v0 risk list (capture is read-only; is anything in boardex-logic risky)?
3. Anthropic API key handling + model list for `capabilities.models` (env-only for v0?).
4. Step granularity: one step per tool call (rough, honest) vs agent-declared step grouping — recommend starting with one-per-call and letting the transcript decide.
5. Estimate + what he needs from our side (likely: nothing in the UI; possibly a mock `BENCH=agent` parity story later).
