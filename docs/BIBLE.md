# BOARDEX UI BIBLE
## Master Build Document for the Boardex Desktop MVP — UI, Contracts, and Claude Code Execution Plan

Version 2.0 · July 2026 — v1.2 contract amendments per §10.5: added `run.iteration_started` event (fix-loop iteration was unrepresentable); removed `nextAction` from RunSummary (UI-derived per T1.2); BenchStatus devices carry the backend registry's stable `id`. v1.3: RunView gains `riskSummary?` populated from `run.plan_generated` (reducer-only change; wire contract unchanged). v1.4: RunView's `logsByStep` values carry the `step.log` stream per line (`{stream, line}[]`), and RunView gains `iterations[]` (`{iteration, reason, firstStepIndex}` from `run.iteration_started`) — both reducer-only; wire contract unchanged (needed by T2.1's per-stream log tabs and iteration divider). v1.5: RunView gains `endedAt?` from the terminal event's envelope `ts` (reducer-only; wire contract unchanged — needed by T2.2's frozen terminal duration). v1.6: RunView's `diagnosis` gains `fixApprovalId?` — the id of the first `approval.requested` following `diagnosis.created` — so the UI binds the Diagnosis Card to exactly its fix approval (reducer-only; wire contract unchanged; T2.2 review F1/F3). **v2.0 (T5.0 conformance hardening — wire changes)**: envelope-first parse rule made normative in §5.1 (an unknown-typed, well-formed envelope still counts toward seq continuity); `ts` accepts naive ISO 8601 (§5.1); the three structured artifact content schemas (protocol_decode — reconciled to the boardex-logic parsers' actual shapes — code_diff, timing_measurement) are contract-owned and emitted to `json-schema/artifacts.schema.json` (§4); the global stream carries the dedicated terminal events `run.completed`/`run.failed`/`run.stopped` (§5.3); §5.7 adds the normative run-status transition graph; §7.1's next-action label for `awaiting_approval` is "Review approval"; the §7.2 bench-degraded warning repeats at hardware-action approvals (§7.3). Reducer-only, same release: legal-ordering reconciliation (§5.4 — early `step.completed`/`approval.resolved` buffered until their entity arrives; a check downgraded by the evidence law upgrades when its artifact lands; only what the stream never reconciles remains a warning), `reduceRun` takes `WireEvent[]` and returns `RunView | null` (§5.4 — ignored envelopes may legally precede `run.created`; a stream with no known event yet is the valid, empty view), and `RunView.warnings` surfaces in the workspace status card. Same release, fixtures: the fail-variant fixture `bme280_run_001_fail.jsonl` (§5.5) and the mock runner's `--fail-variant`/`FIXTURE=fail` switch (§5.6) exercise the `failed` terminal.

**v2.1 (T6.3 Documents & Sources — additive wire changes; proposed to the backend owner by PR). All fields are optional, so a v2.0 consumer that ignores them still conforms; the wire `contractVersion` stays `boardex-contract/0.1`.** (1) `BoardProfile` gains `documents?: BoardDocument[]` where `BoardDocument = { id, label, kind: 'datasheet'|'schematic'|'reference', mimeType }` — profile-attached reference material the runner owns and serves (§4). (2) Two new routes serve documents by reference: `GET /documents/{id}` (content, Content-Type per the document's `mimeType`) and `GET /documents/{id}/meta` (the `BoardDocument`) (§5.3). (3) `MeasurementCheck` gains `sourceDoc?: { documentId, locator? }` — the resolvable form of a citation, beside the existing free-text `sourceRef` (which stays as the fallback rendering) (§4). (4) Runner capabilities, riding along for T6.6: `GET /health` gains `capabilities?: { models?: string[] }`; `POST /runs` (CreateRun) gains `model?: string`; `Run` gains `model?: string` (echoed) (§4/§5.3). Reducer unchanged (optional fields pass through RunView on their entities). Mock, same release: the canned Nucleo-F303RE profile carries two authored documents (a BME280 datasheet excerpt — §5.4.1 addressing + the §6.2 timing spec — and schematic pin-mapping notes), serves them per the new routes, and `/health` advertises `capabilities.models: ['mock-model']`; both fixtures' `i2c_clock`/`device_ack` `check.evaluated` payloads gain `sourceDoc` pointing at the datasheet excerpt with heading locators (payload-only — no new events, no seq changes). Documents-tab/deep-link/model-select UI is T6.3 stage 2.

**v2.2 (T6.2 Workspace as theater — reducer-only, wire unchanged; documented in the T6.5 §9.3 debt pass):** RunView's `logsByStep` values carry a per-line `ts` (`{stream, line, ts}[]`, §5.4). The `ts` is the `step.log` envelope's `ts`, so every line of a batched `lines[]` frame shares one timestamp — the only honest option, since the contract times events, not individual lines. It feeds the workspace LogViewer's optional per-line timestamp column (§6.2/§7.3). No new events, no seq changes; the wire `contractVersion` stays `boardex-contract/0.1`.

**v2.3 (Sprint 7 P0 — visual system only; zero wire/reducer changes):** §6 rewritten to the premium visual system from the external design review (docs/design/Boardex_MVP_UI_Design_Review.docx, 2026-07): a three-layer surface hierarchy (canvas `#F7F7F8` / navigation `#FBFBFC` / primary white) replacing the two-tone `#FAFAF9`/white scheme; the full color set re-pointed (borders `#E2E3E7`/`#D2D4DA`, text `#17171A`/`#5C6068`, accent `#5B4CF0`, pass `#168A4A`, fail `#C73535`, warn `#A86D00`) — old values are RETIRED, not aliased; a rewritten type ladder (page 22px, top-bar/section 15px, card/step titles 14px semibold, metadata 12px, code 12.5px mono) with the 12px state-text floor and the 11px label step reserved for the two machine capsules; geometry on the 8px grid (card radius 8px, control radius 6px, buttons 36/40px, sidebar 208px, right rail 320px, evidence drawer 840px); motion extended (not replaced) with the 280ms FAIL→PASS morph token; §6.2's Badge split into four classes (run-state / risk / verdict / inline step status). D14 reservations, flow, and the contract are unchanged.

**v2.4 (Sprint 7 P0 stage 4 — the declared check registry; ONE additive wire field per §10.5, proposed to the backend owner by PR; the wire `contractVersion` stays `boardex-contract/0.1`):** `run.plan_generated` gains `checks?: CheckExpectation[]` where `CheckExpectation = { requirementId, description }` — the plan DECLARES what the run intends to verify (the runner's `declare_plan(steps, risk_summary, checks)` already captures this list; it now reaches the wire). Reducer, same release: RunView gains `registeredChecks?` (the declared registry, verbatim) and `terminalSummary?` (the terminal event's `summary`; a terminal `run.status_changed.reason` is the fallback, the dedicated event takes precedence — the "why it ended" beside v1.5's `endedAt` "when"). These feed the §7.3/§7.6 dual-outcome split: *Run execution* (status + terminal reason) vs *Validation coverage* (recorded `check.evaluated` results measured against the declared registry). A producer that declares no registry (any pre-v2.4 recording, e.g. records/bmp180-run) reduces unchanged, and consumers MUST then report coverage without a denominator ("N checks recorded · no check registry declared") — the denominator is never parsed from plan prose or report markdown, and never invented. Fixtures: the authored `bme280_run_001.jsonl` declares its three checks; the new SYNTHETIC partial-coverage fixture `bme280_run_002_partial_synthetic.jsonl` (§5.5 — clearly marked, not a recording) declares six and records two, exercising the Not-recorded presentation end to end.
Owners: Kerem (UI/UX, product, contract, mock runner) · Cofounder (MCP servers, orchestrator service, firmware)
Status: ACTIVE — this is the source of truth for the UI build. When this document and any older spec disagree, this document wins.

---

# 0. How to Use This Document

This is the operating bible for building the Boardex UI with Claude Code. It contains, in order: the product decisions already made (§1–2), the architecture and data contract (§3–5), the design system (§6), the screen specifications (§7), the sprint plan with verbatim Claude Code prompts (§8), the working protocol for every task (§9), and the backend integration contract (§10).

Rules of engagement:

1. Every Claude Code session starts by reading `CLAUDE.md` (created in Task 0.1), which points here.
2. Tasks are executed one at a time, in order, each ending in an atomic commit.
3. Every task is followed by a **fresh-context adversarial review** (§9.2) before Kerem accepts it.
4. Nothing in the Deferred Register (§2.3) gets built, referenced, or "prepared for" without an explicit decision. Speculative generality is a bug.
5. When Claude Code is uncertain, it must stop and ask rather than invent. Inventing schema fields, event types, or design tokens not defined here is a blocking review failure.

---

# 1. Product Context (read once, internalize)

**Boardex** is an autonomous hardware-in-the-loop bring-up and validation agent for embedded teams. The engineer gives it a goal ("Bring up the BME280 sensor over I2C on this STM32 board, verify timing, confirm valid readings over serial"). Boardex plans, writes firmware, builds, flashes, drives lab instruments, captures measurements, diagnoses failures, iterates, and produces an evidence-linked validation report. Every conclusion links to a physical artifact: serial logs, logic traces, protocol decodes, code diffs.

**The one-line product principle: every firmware change ships with physical proof.**

**The one-line UI principle: a new user understands Boardex in under one minute.** The first screen says, visually and functionally: "Tell Boardex what to validate. Boardex will plan, run, measure, and report."

**Division of labor:** Kerem builds everything in this document (UI + contract package + mock runner). The cofounder owns `servers/` — today three MCP servers (`boardex-core` shared interfaces/evidence, `boardex-target` pyOCD flash/debug/RTT/peripheral inspection, `boardex-logic` sigrok capture + protocol decode for the Kingst LA), and later a thin **orchestrator service** (`servers/boardex-runner`) that runs the agent loop, calls the MCP tools, and emits the §5 event stream. The UI never speaks MCP; the two sides meet at the contract in §5 and nowhere else.

**Competitive posture (context, not a build input):** Embedder (YC S25) and BootLoop (YC) are funded competitors in this exact category; both are CLI/terminal-shaped. Boardex differentiates on (a) the evidence-first run workspace and shareable validation report, (b) a future standardized test bench, (c) trust UX. This is why UI quality is strategy, not polish.

---

# 2. Decisions Already Made — Do Not Relitigate

## 2.1 Locked decisions

| # | Decision | Ruling |
|---|----------|--------|
| D1 | Product form | Local web app now (browser UI + local runner). Tauri desktop wrap is a later, near-free port. No Electron. |
| D2 | UI spec baseline | Section 17 of the UI Product Spec ("Simplified Light UI") **is** the MVP spec. The dense five-zone cockpit (spec §5–8) is future expert mode. |
| D3 | Stack | React 18 + TypeScript (strict) + Vite + Tailwind CSS. State: Zustand. Server data: TanStack Query. Router: React Router. Realtime: native WebSocket. Tests: Vitest + React Testing Library. |
| D4 | Transport split | UI **receives** an append-only, sequence-numbered JSON event stream per run over WebSocket. UI **sends** commands over HTTP POST. Artifacts are fetched by reference over HTTP, never embedded in events. |
| D5 | State model | Event sourcing. Run state in the UI is a pure reduction over the ordered event list. Reconnect = replay from last seq. History = re-reduction. |
| D6 | Mock-first development | The entire UI is built against a mock runner replaying a recorded/authored fixture of one real BME280 bring-up run (including one failure + fix iteration). Real-runner integration is a contract-conformance exercise (§10), not a discovery process. |
| D7 | Contract source of truth | Zod schemas in `packages/contract`. TypeScript types are inferred from Zod. JSON Schema is emitted from Zod for the Python runner side. One source, two consumers. |
| D8 | Persistence (MVP) | Runner side owns persistence. UI holds no database; it reduces events and caches via TanStack Query. Mock runner persists nothing beyond fixture state in memory. |
| D9 | Report export | Markdown only. |
| D10 | Waveforms | **No waveform viewer.** Evidence = pass/fail check cards + decoded protocol transaction tables + measured values vs. expected windows + serial logs + raw-capture download link (sigrok .sr file, opens in PulseView). A simple inline SVG summary of a measured value against its window is allowed; waveform rendering is not. |
| D11 | Power | Manual power mode only. UI shows expected voltage/current and asks for human confirmation. No programmable PSU control anywhere in the MVP. |
| D12 | Wiring diagrams | No auto-generated connection diagrams. The board profile stores a human-authored **connection checklist**; the UI renders it as a confirm-each-line list before a run. |
| D13 | Single user | No auth, no workspaces, no teams. One user, one local runner, one bench. |
| D14 | Visual direction | Light UI. White/very-light-gray background, soft panels, restrained borders, high whitespace. One accent color for actions. Green exclusively for pass/success. Red exclusively for fail/stop. Amber exclusively for approval-needed/warning. |
| D15 | Language/tone in UI | Plain engineering language. No AI theater ("thinking...", sparkles, personas). Boardex reads as a careful lab engineer. |

## 2.2 The six run-workspace states (verbatim from spec §17.7 — this is the product)

| State | What the user sees | Primary action |
|---|---|---|
| Empty / New task | Large "Ask Boardex" composer, detected board context, lab readiness | Create Run Plan |
| Plan generated | Plain-language plan (5–6 steps), risk summary, required hardware actions | Approve Plan |
| Running | Active step, compact progress, pause/stop controls, latest artifact | Pause or inspect current step |
| Needs approval | Proposal card: change, reason, risk, files changed, hardware action | Approve & Continue / Review Diff / Stop Run |
| Failed measurement | Failure summary, likely causes, evidence card | View Evidence / Approve Fix Plan |
| Completed | Evidence summary, code diff summary, report preview | Generate / Export Report |

## 2.3 Deferred Register — collective memory, explicitly NOT in MVP

These were cut deliberately. They return in future tracks. Do not build, stub, or architect for them beyond what the contract naturally allows.

1. Auto-generated wiring/connection diagrams from netlist + pin mappings.
2. Programmable power supply control (SCPI/PyVISA, Riden RD60xx), voltage sweeps, power-electronics workflows.
3. Waveform viewer / trace rendering.
4. PDF and DOCX report export.
5. Teams, workspaces, permissions, audit UI, enterprise mode.
6. Expert cockpit mode (five-zone shell: top bar + sidebar + right drawer + bottom console).
7. Tauri desktop packaging and signed installers.
8. Oscilloscope adapters, Saleae/Digilent adapters, power profilers (MVP instrument surface: pyOCD debug probe + UART/RTT + one logic-analyzer path: Kingst LA via sigrok).
9. Scheduled runs, PR integration, CI-for-hardware (Track 3).
10. Boardex-designed standardized test bench hardware (strategic; revisit post-MVP).
11. Hardware Design From Scratch mode (deleted from near-term product entirely).

---

# 3. Repository Architecture

Monorepo. The joint repo already contains the cofounder's Python MCP servers under `servers/` — our scaffold is added **alongside**, never inside or on top of it. npm workspaces cover `packages/*`, `apps/*`, `tools/*` only; `servers/` is Python-land with per-package `pyproject.toml` and is invisible to npm.

```
boardex/                           # the joint repo (github.com/ankayca/boardex)
├── CLAUDE.md                      # Claude Code operating rules (created in T0.1)
├── README.md                      # cofounder's — do not rewrite without him
├── docs/
│   ├── BIBLE.md                   # this document
│   ├── decisions.md               # append-only decision log
│   ├── ARCHITECTURE.md            # cofounder's — read, don't own
│   └── *.md                       # his bring-up / debug notes
├── servers/                       # COFOUNDER'S DOMAIN — Kerem's tasks never modify it
│   ├── boardex-core/              # shared interfaces, evidence, registry (Python)
│   ├── boardex-target/            # pyOCD flash/debug, RTT, peripherals (Python, MCP)
│   ├── boardex-logic/             # sigrok capture + decode, Kingst LA (Python, MCP)
│   └── boardex-runner/            # FUTURE: orchestrator service emitting the §5
│                                  #   event stream (agent loop over the MCP tools)
├── examples/firmware/             # cofounder's reference firmware (Nucleo-F303RE)
├── packages/
│   └── contract/                  # THE contract. Zod schemas, inferred TS types,
│       ├── src/
│       │   ├── events.ts          # event envelope + all event payload schemas
│       │   ├── commands.ts        # HTTP request/response schemas
│       │   ├── entities.ts        # Run, RunStep, Artifact, MeasurementCheck, ...
│       │   ├── reducer.ts         # events[] -> RunView pure reduction + tests
│       │   └── index.ts
│       ├── fixtures/
│       │   └── bme280_run_001.jsonl   # the authored (later recorded) demo run
│       └── json-schema/           # emitted JSON Schema for the Python side
├── apps/
│   └── ui/                        # React app (structure unchanged from v1.0)
└── tools/
    └── mock-runner/               # TS/Node server replaying fixtures per §5
```

Dependency rule: `apps/ui` and `tools/mock-runner` both import `packages/contract`. Nothing imports from `apps/ui`. The contract package has **zero** runtime dependencies besides `zod`. Cross-language rule: TypeScript never imports from `servers/`, Python never reads TS — the emitted JSON Schema in `packages/contract/json-schema/` is the only bridge.

---

# 4. Core Data Model (entities)

Defined in `packages/contract/src/entities.ts` as Zod schemas. Canonical shapes (abbreviated here; the schemas in code are the authority once created — and they must match this section at creation time):

```ts
// Identifiers are string ULIDs.

RunStatus = 'draft' | 'planning' | 'plan_ready' | 'running'
          | 'awaiting_approval' | 'diagnosing' | 'completed'
          | 'failed' | 'stopped'

RiskLevel = 'low' | 'medium' | 'high' | 'critical'

StepKind = 'understand_context' | 'edit_code' | 'build' | 'flash'
         | 'capture' | 'read_serial' | 'evaluate' | 'diagnose' | 'report'

StepStatus = 'pending' | 'active' | 'succeeded' | 'failed' | 'skipped'

Run = {
  id, title, taskPrompt: string,
  boardProfileId: string,
  status: RunStatus,
  plan?: PlanStep[],            // plain-language, 5-8 steps
  createdAt, updatedAt: string, // ISO 8601
  iteration: number,            // fix-loop counter, starts at 1
  model?: string,               // v2.1: the runner model this run used (echoed from CreateRun.model)
}

PlanStep = { index: number, title: string, detail: string,
             riskLevel: RiskLevel, hardwareAction: boolean }

RunStep = { id, runId, planIndex: number, kind: StepKind,
            status: StepStatus, title: string,
            startedAt?, endedAt?: string,
            summary?: string,            // agent's short explanation
            artifactIds: string[] }

Artifact = { id, runId, stepId,
  kind: 'serial_log' | 'build_log' | 'flash_log' | 'logic_capture'
      | 'protocol_decode' | 'code_diff' | 'timing_measurement' | 'report_md',
  label: string, mimeType: string, sizeBytes: number,
  // content fetched via GET /artifacts/{id}; decode/diff/timing kinds
  // return structured JSON, log kinds return text/plain
}

MeasurementCheck = { id, runId, requirementId: string,
  description: string,                     // "I2C clock must be 100 kHz ±10%"
  measurement: string,                     // "logic_analyzer.i2c.scl_frequency"
  expected: { min?: number, max?: number, equals?: boolean|string, pattern?: string },
  actual: { value: number|boolean|string, unit?: string },
  verdict: 'pass' | 'fail' | 'needs_review',
  artifactId: string,                      // REQUIRED — evidence linking is law
  sourceRef?: string,                      // e.g. "BME280 datasheet §6.2" (free-text; fallback rendering)
  sourceDoc?: { documentId: string,        // v2.1: the resolvable form of the citation — a
                locator?: string }         // BoardProfile.documents[] id + optional in-document locator
                                           // (a markdown heading slug/anchor, or best-effort text)
}

// v2.1: profile-attached reference material. The runner owns the bytes and serves
// them by reference (§5.3 GET /documents/{id}); the builder edits metadata only.
BoardDocument = { id: string, label: string,
  kind: 'datasheet' | 'schematic' | 'reference',
  mimeType: string }                       // e.g. "text/markdown", "application/pdf"

Approval = { id, runId,
  proposal: { title: string, reason: string, riskLevel: RiskLevel,
              filesChanged: string[], hardwareActions: string[] },
  status: 'pending' | 'approved' | 'rejected',
  resolvedAt?: string }

Diagnosis = { id, runId, failedCheckIds: string[],
  hypotheses: { cause: string, evidence: string, confidence: 'high'|'moderate'|'low' }[],
  proposedFix: { summary: string, riskLevel: RiskLevel, filesChanged: string[] } }

BoardProfile = { id, name, mcu: string,
  repoPath, buildCommand, flashCommand, resetCommand: string,
  serial: { port: string, baud: number },
  instruments: { debugProbe: string,            // e.g. "ST-Link (on-board, via pyOCD)"
                 logicAnalyzer?: string },       // e.g. "Kingst LA2016 (sigrok)"
  safety: { maxIterations: number, flashRequiresApproval: boolean,
            powerNote: string },          // manual power mode text
  connectionChecklist: { label: string, detail: string }[],  // D12
  knownQuirks: string[],
  documents?: BoardDocument[] }               // v2.1: reference material served by the runner (§5.3)

BenchStatus = { runnerOnline: boolean, contractVersion: string,
  devices: { id: string,    // backend registry's stable device_id, e.g. "sigrok:kingst-la2016:conn=3.12"
             kind: 'debug_probe'|'serial'|'logic_analyzer',
             name: string, state: 'online'|'offline'|'error', detail?: string }[] }
```

**Structured artifact content (v2.0):** the structured kinds' JSON bodies are contract-owned schemas in `packages/contract/src/artifacts.ts`, emitted to `json-schema/artifacts.schema.json`: `protocol_decode` → `ProtocolDecodeContent` (annotations exactly as `servers/boardex-logic`'s `parse.py::parse_annotations` yields them — `{ raw, start?, end?, decoder?, text }` — folded into transactions exactly as `decode/i2c.py::parse_transactions` does), `code_diff` → `CodeDiffContent` (`{ files: [{ path, reason, diff }] }`), `timing_measurement` → `TimingMeasurementContent` (`{ measurement, valueHz }`). The runner serves its pipeline output verbatim; the UI parses with the same schemas.

**Evidence-linking law (enforced in the reducer and in review):** a `MeasurementCheck` without a resolvable `artifactId` is invalid. A run cannot reach `completed` with unresolved `needs_review` checks unless the user explicitly accepts them.

---

# 5. The Contract: Event Stream + Command API

This section is the single most important interface in the company. Both the mock runner and the cofounder's real runner MUST conform to it exactly. Contract version: `boardex-contract/0.1`.

## 5.1 Event envelope

Every event, no exceptions:

```json
{
  "seq": 42,                        // monotonic per run, starts at 1, no gaps
  "runId": "01J1...",
  "ts": "2026-07-07T14:03:22.114Z",
  "type": "step.log",
  "payload": { }
}
```

Rules: `seq` is per-run and gapless — the UI treats a gap as a protocol error and re-fetches via HTTP replay. Events are immutable and append-only. Unknown event types must be ignored by the UI (forward compatibility), but unknown types appearing in review of the mock runner are a failure (backward discipline). `ts` is ISO 8601; a naive (zoneless) timestamp is legal on the wire — producers SHOULD emit UTC with `Z`.

**Envelope-first parsing (normative, v2.0):** because `seq` is gapless, "ignore" cannot mean "drop". Consumers parse every frame against the envelope first; a well-formed envelope whose type (or payload) fails the catalog parse still counts toward seq continuity and is then discarded without effect. This applies identically to the live WS stream and the HTTP replay body — an unknown-typed event in the log must not fail the replay response, or reconnect becomes a loop. Frames that are not well-formed envelopes at all carry no accountable `seq` and are dropped.

## 5.2 Event catalog (complete for MVP)

| type | payload (summary) | emitted when |
|---|---|---|
| `run.created` | `{ run: Run }` | run row exists |
| `run.plan_generated` | `{ plan: PlanStep[], riskSummary: string, checks?: CheckExpectation[] }` — `CheckExpectation = { requirementId, description }`, the declared check registry (v2.4, optional/additive) | plan ready for approval |
| `run.status_changed` | `{ status: RunStatus, reason?: string }` | any status transition |
| `step.started` | `{ step: RunStep }` | step begins |
| `step.log` | `{ stepId, stream: 'build'\|'flash'\|'serial'\|'rtt'\|'agent', line: string }` | one log line (batching allowed: `lines: string[]`) |
| `step.completed` | `{ stepId, summary: string, artifactIds: string[] }` | step succeeds |
| `step.failed` | `{ stepId, summary: string, artifactIds: string[] }` | step fails |
| `artifact.created` | `{ artifact: Artifact }` | artifact is fetchable |
| `check.evaluated` | `{ check: MeasurementCheck }` | pass/fail known |
| `diagnosis.created` | `{ diagnosis: Diagnosis }` | after failed checks |
| `approval.requested` | `{ approval: Approval }` | run pauses for human |
| `approval.resolved` | `{ approvalId, status, resolvedAt }` | human decided |
| `run.iteration_started` | `{ iteration: number, reason: string }` | fix loop begins a new iteration (emitted for iteration >= 2 only; iteration 1 is implicit) |
| `run.completed` | `{ summary: string, reportArtifactId: string }` | terminal success |
| `run.failed` | `{ summary: string }` | terminal failure |
| `run.stopped` | `{ byUser: true }` | user stop honored |
| `runner.status` | `{ bench: BenchStatus }` | on connect + on device change (runId = "_global") |

## 5.3 Command API (HTTP, JSON)

```
GET  /health                         -> { ok, contractVersion, runnerKind: 'mock'|'real',
                                          capabilities?: { models?: string[] } }  // v2.1 (feature-detected)
GET  /bench                          -> BenchStatus
GET  /board-profiles                 -> BoardProfile[]
POST /board-profiles                 -> create/update BoardProfile
GET  /documents/{id}                 -> content (Content-Type per BoardDocument.mimeType)   // v2.1
GET  /documents/{id}/meta            -> BoardDocument                                        // v2.1
GET  /runs                           -> RunSummary[]  (id, title, status, boardProfileId, updatedAt)
POST /runs                           { taskPrompt, boardProfileId, model? } -> { runId }   // model? v2.1
POST /runs/{id}/plan/approve         {}                                     -> 204
POST /runs/{id}/approvals/{aid}      { status: 'approved'|'rejected' }      -> 204
POST /runs/{id}/stop                 {}                                     -> 204
GET  /runs/{id}/events?afterSeq=N    -> Event[]        (HTTP replay for reconnect/history)
GET  /artifacts/{id}                 -> content (Content-Type per artifact.mimeType)
GET  /artifacts/{id}/meta            -> Artifact
WS   /ws?runId={id}                  -> event stream for one run (server pushes; client sends nothing)
WS   /ws?global=1                    -> runner.status + run.created + run.status_changed
                                        + run.completed + run.failed + run.stopped for all runs (dashboard;
                                        v2.0 — a run ending via its dedicated terminal event must reach the
                                        dashboard without a redundant run.status_changed riding along)
```

Command errors: HTTP 409 with `{ error, currentStatus }` when a command is invalid for the run's state (e.g. approving an already-resolved approval). The UI must render 409s as state refresh, not as crashes. `GET /runs/{id}/events` with an unknown run id answers 404, and the UI treats that 404 as deterministic and fails closed — a distinct not-found state (honest copy, a way back to Runs), never a retry loop or the reconnecting treatment (T5.2).

## 5.4 The reducer (contract-owned, UI-consumed)

`packages/contract/src/reducer.ts` exports:

```ts
reduceRun(events: WireEvent[]): RunView | null
// WireEvent = Event | IgnoredEvent, the envelope-first parse's output (§5.1): an
// ignored envelope advances seq continuity and carries no state. Returns null —
// the valid, empty view — while the stream holds no known event yet (ignored
// envelopes may legally precede run.created); throws ProtocolError only on a seq
// gap or a KNOWN-typed stream that starts before run.created.
// RunView = { run, steps[], artifacts[], checks[], approvals[],
//             diagnosis?: Diagnosis & { fixApprovalId?: string },
//             riskSummary?: string, registeredChecks?: CheckExpectation[],
//             terminalSummary?: string, endedAt?: string,
//             logsByStep: Map<stepId, {stream, line, ts}[]>,
//             iterations: {iteration, reason, firstStepIndex}[], lastSeq,
//             warnings: string[] }   // contract violations observed while reducing
```

Pure, deterministic, unit-tested against the fixture. Legal-ordering reconciliation (v2.0/T5.0): seq is ordered but §5.2 does not promise an `artifact.created` precedes the check citing it, a `step.started` precedes its outcome, or an `approval.requested` precedes its resolution — the reducer buffers such early references and reconciles them when the entity arrives; a check the evidence law downgraded to `needs_review` gets its wire verdict back when its artifact lands; only what the stream never reconciles remains in `RunView.warnings`. `logsByStep` values are `{stream, line, ts}[]` (v2.2/T6.2): each line carries the `ts` of the `step.log` envelope it arrived on, so the lines of one batched `lines[]` frame share a timestamp — the contract times events, not individual lines. `riskSummary` is populated from `run.plan_generated` and is undefined before the plan exists. `registeredChecks` (v2.4) is `run.plan_generated.checks` verbatim — undefined when the producer declared none, in which case coverage renders WITHOUT a denominator. `terminalSummary` (v2.4) is the terminal event's `summary` (a terminal `run.status_changed.reason` is the fallback; the dedicated event wins; `run.stopped` sets none — `byUser` is the whole story — and a stopped run's fallback survives only when it is non-generic: the "Stopped by user" boilerplate riding the mock's transition is suppressed, since the Stopped badge already says exactly that; Sprint 7 review ruling, 2026-07-19). `endedAt` is the envelope `ts` of the terminal event (`run.completed` / `run.failed` / `run.stopped`, or a `run.status_changed` carrying a terminal status; the dedicated terminal events take precedence) and is undefined while the run is non-terminal. `diagnosis.fixApprovalId` is the id of the first `approval.requested` whose seq follows the `diagnosis.created`, and is undefined until that approval arrives — it is how the UI knows which pending approval is the fix approval. The UI NEVER derives run state any other way — if the UI needs data RunView lacks, extend RunView via the reducer; never read the event list directly.

## 5.5 Fixture: `bme280_run_001.jsonl`

One JSON event per line, plus a replay pacing field consumed only by the mock runner and stripped before sending:

```json
{"delayMs": 800, "event": { "seq": 1, "runId": "...", "type": "run.created", ... }}
```

The fixture tells this exact story (this narrative is the demo script and the acceptance test):

1. Run created for "Bring up BME280 over I2C on the Nucleo-F303RE. Verify I2C timing and confirm valid temperature/humidity readings over serial."
2. Plan generated: 6 plain-language steps (understand context → modify firmware → build & flash → capture I2C + serial → validate against spec → report). One medium-risk hardware action (flash).
3. `awaiting plan approval` → (user approves via mock runner pause).
4. Steps execute: context (datasheet §5.4.1 I2C address 0x76 cited), code edit (diff artifact), build via Make/arm-none-eabi-gcc (log artifact), **approval.requested** for flash (pyOCD) → user approves.
5. Capture + serial read. Checks evaluated: `i2c_clock` PASS (measured 99.6 kHz in 90–110 kHz window, linked to logic capture artifact), `device_ack` **FAIL** (NACK at 0x76, linked to protocol decode artifact), `serial_output` FAIL (no TEMP/HUM pattern).
6. `diagnosing`: Diagnosis with 3 hypotheses (wrong 7-bit vs 8-bit address shift — high confidence, cited decode evidence; pull-up issue — low; init order — low). Proposed fix: correct address handling, risk medium, 1 file.
7. `approval.requested` for fix + re-flash → user approves. Iteration 2: edit, build, flash, capture. All checks PASS (device_ack true, serial shows `TEMP=24.3 HUM=41.2`).
8. `run.completed` with report artifact (Markdown, evidence-linked).

Artifacts referenced by the fixture live as static files in `fixtures/artifacts/` (small, realistic: a plausible diff, ~40 lines of serial log, a decoded I2C transaction table as JSON, a build log). The cofounder later replaces this authored fixture with a genuinely recorded one — same format, zero UI changes.

**Fail variant (v2.0): `bme280_run_001_fail.jsonl`** — the correct-fix-meets-faulty-hardware ending. Verbatim identical to the base story through iteration 2's flash (seq 68; asserted by the fixture test), then diverges: the capture decodes NACKs on every address phase at the *corrected* wire byte 0xEC, serial shows the same `i2c1_wait` timeout lines as iteration 1 (the driver has no NACKF handling, so the UART cannot tell the two failures apart — only the decode can), `device_ack` and `serial_output` fail again, and with nothing left to propose the run ends in `run.failed` with **no further approval requested**. Its own `iter2f` evidence artifacts live alongside the base set. This is the UI's real `failed` terminal (§2.2) — evidence retained, no report.

## 5.6 Mock runner behavior (tools/mock-runner)

Node + TypeScript, `ws` + a minimal HTTP layer. Behavior:

- Serves the full Command API from §5.3 against in-memory state seeded by the fixture.
- `POST /runs` starts a replay session of the fixture (re-keyed with a fresh runId).
- Replays events over WS with `delayMs` pacing; a `SPEED` env var (default 1.0) scales delays for demos/tests.
- **Pauses** replay at `run.plan_generated` and at every `approval.requested`, and resumes only when the corresponding HTTP command arrives. Reject on an approval routes to a short alternate ending (`run.stopped`) — good enough for MVP.
- `POST /runs/{id}/stop` at any time emits `run.stopped` and halts replay.
- Supports `GET /runs/{id}/events?afterSeq=` from its in-memory log (reconnect testing).
- Serves fixture artifacts with correct MIME types.
- Ships one canned BoardProfile ("Nucleo-F303RE") and a BenchStatus with probe (ST-Link/pyOCD), serial, and logic analyzer (Kingst LA2016 via sigrok) all online, plus a `--degraded` flag that marks the logic analyzer offline (for readiness-UI testing).
- `--fail-variant` (or env `FIXTURE=fail`) replays the fail-variant fixture (§5.5) instead of the base story — same gates, but iteration 2's checks fail again and the run ends in `run.failed` (v2.0; for failed-terminal UI testing).

## 5.7 Run status transitions (normative, v2.0)

A conforming runner moves a run's status only along these edges. Anything else is a contract violation, whether it arrives via `run.status_changed` or a dedicated event.

```
draft ──► planning ──► plan_ready ──► running
                                        │  ▲
                                        ▼  │ (approved)
                                awaiting_approval
                                        ▲
                                        │ (fix approval requested)
running ──► diagnosing ─────────────────┘
running    ──► completed | failed
diagnosing ──► failed            (no viable fix / iteration cap)
any non-terminal ──► stopped     (user stop, or approval rejected)
```

Rules:

1. **Terminal states are terminal.** `completed`, `failed`, `stopped` have no outgoing edges; nothing follows the dedicated terminal event.
2. **A runner blocking on plan approval MUST have reported `plan_ready`.** The pause at the plan gate is visible state, not an implementation detail: `run.plan_generated` is emitted at or after the `plan_ready` transition, never while the run still reads `planning`.
3. **`awaiting_approval` is entered only with a pending approval.** An `approval.requested` accompanies (or immediately follows) the transition; approving returns the run to `running`, rejecting ends it via `stopped`.
4. **`diagnosing` follows failed checks** and exits either to `awaiting_approval` (fix proposed) or `failed` (nothing left to propose, or the profile's iteration cap is reached).

---

# 6. Design System

## 6.1 Tokens (Tailwind theme extension — exact values; Sprint 7 P0 system)

```
Surfaces (three layers — white work surfaces read against a tinted shell,
never white-on-white):
  Application canvas: #F7F7F8  (the shell background; --color-canvas)
  Navigation surface: #FBFBFC  (sidebar; --color-nav)
  Primary surface:    #FFFFFF  (cards, workspace, report, drawer, modals; --color-surface)
Border:            #E2E3E7 default · #D2D4DA strong (focused cards, tables, approvals)
Text primary:      #17171A
Text secondary:    #5C6068
Accent (actions):  #5B4CF0; hover #4A3BD8 (derived: one step darker, same hue);
  bg tint #ECEBFB (Sprint 7 P1 — the cited-source highlight's resting tint; a
  light tint of the accent, NOT a D14 semantic, so a citation may wear it)
Pass/success ONLY: #168A4A; bg tint #E8F5EE
Fail/stop ONLY:    #C73535; bg tint #FBEDED
Approval/warn ONLY:#A86D00; bg tint #FAF3E4
Neutral badge:     #3F434B on #E9EAEE  (a FILLED capsule with dark text — a
  neutral state, e.g. LOW risk, must never read as disabled)
Scrim (overlays):  rgba(23,23,26,0.35)  (--color-scrim; text-primary at 35%
  alpha, not a new hue — light enough that the dimmed run stays legible
  behind the evidence drawer)
Radius: 8px cards, 6px controls (buttons/inputs); badges stay pill-shaped.
Elevation (2 levels — depth reads from the surface hierarchy + 1px borders;
  shadows exist ONLY on floating layers: palette, modals, drawer, demo callout.
  Resting cards carry NO shadow):
  raised   0 1px 2px rgba(0,0,0,0.05), 0 3px 10px rgba(0,0,0,0.06)   floating over content
  overlay  0 2px 8px rgba(0,0,0,0.07), 0 16px 40px rgba(0,0,0,0.12)  dialogs/drawers
Motion (Sprint 7 extends, never replaces): fast 120ms (hover/focus — the
  100–140 band) · medium 200ms (badge/state transitions, 160–200 band; and
  drawer/modal surfaces, 200–240 band, entrance ease = the ease-out) ·
  gentle 360ms (progress) · morph 280ms (FAIL→PASS verdict: icon morph +
  ONE restrained background pulse, 240–300 band; --motion-morph) · arrival 700ms
  (Sprint 7 P1 — a one-shot "you landed here" wash, 600–800 band, slower than a
  state flip so it reads as settling; --motion-arrival) · ambient 2s
  (the looping active-step pulse; --motion-ambient); eases
  cubic-bezier(0.2,0,0,1) standard, cubic-bezier(0.16,1,0.3,1) entrance;
  prefers-reduced-motion removes pulses and swaps states instantly.
Focus: one 2px accent :focus-visible ring, offset 2px, on ALL interactive
  controls; text fields keep their accent-border focus instead.
Spacing: 8px grid (4/8/12/16/24/32); panels padded 16–24px; sections 32px.
Type: Inter (UI), JetBrains Mono (logs, decode, diffs, values, commands) — the
  mono fallback stack is JetBrains Mono → ui-monospace → SFMono-Regular → Menlo →
  Consolas → DejaVu Sans Mono → monospace, so a glyph absent from JetBrains Mono
  resolves to a symbol-covering mono face on each OS (Consolas on Windows,
  SF Mono/Menlo on macOS, DejaVu Sans Mono on Linux) before the last-resort
  generic that renders tofu;
  tabular numerals app-wide — measurement columns align in either face.
Scale (the ladder — line-height/tracking fixed per step):
  composer 24/32 −0.019em (Ask Boardex only) · page 22/28 −0.017em (page
  titles, report title) · section 15/20 −0.01em (top-bar title, report
  section headings) · title = 14/20 SEMIBOLD (card + step titles; body
  metrics, weight is the step) · body 14/20 · meta 13/18 (secondary text) ·
  metadata 12/16 (timestamps, counts, chips) · code 12.5/19 mono (logs,
  decode, diff) · label 11/16 +0.05em uppercase — reserved EXCLUSIVELY for
  the two machine capsules (run-state and risk badges).
```

Hard rules: green/red/amber are semantically reserved (D14) — never decorative. One accent. No gradients, no glassmorphism, no dark mode in MVP. Density: calm by default; monospace areas (logs, decode tables) may be dense. **12px floor:** any state-bearing text renders at ≥12px; the 11px label step exists only inside the run-state and risk capsules. **Color-noise budget:** repeated per-step "Succeeded" is neutral text + a green check icon; green TEXT is reserved for summary and final verdicts. Geometry: buttons 36px standard / 40px gate-primary; minimum interactive target 32px; sidebar 208px expanded / 56px collapsed; top bar 48px; workspace right rail 320px; evidence drawer 840px (capped 47vw). The pre-v2.3 values (#FAFAF9 shell, #4F46E5 accent, 10px cards, 240px sidebar, 340px rail, 16px section titles…) are retired — nothing in the codebase may reference them.

## 6.2 Primitives to build once (design/):

`Button` (primary / secondary (white surface, strong border) / tertiary-danger (text button — red only under hover/focus intent; the Approval card's Reject) / danger / outline-danger / ghost; heights 36px standard, 40px gate-primary; loading states use specific verbs — Approving…, Rejecting…, Validating…, never a bare spinner) · `Card` · `Badge` (four classes, below) · `StatusDot` (online/offline/error) · `KeyValue` row · `Progress` (thin bar) · `LogViewer` (virtualized, monospace, auto-follow with pause-on-scroll; plus, T6.2, an optional per-line timestamp column when timestamps are supplied and client-side find-in-log with case-insensitive match highlighting and next/prev navigation) · `EmptyState` · `ConfirmDialog` · `Drawer` (right-side, for details-on-demand) · `useFocusTrap` (v2.4 — THE modal focus behavior, one implementation: CommandPalette, ShortcutsHelp, Drawer, and ConfirmDialog all trap Tab inside themselves and restore focus to the invoking control on close)

**Interaction conventions (v2.4):** Esc closes ONLY the topmost surface — every consuming handler is element-level and calls stopPropagation (no window-level Escape listeners); the find-in-log field consumes Esc only while it has a query. One polite aria-live region announces run-state changes and approval arrivals — never streamed log lines (the LogViewer log region is `aria-live="off"`). prefers-reduced-motion removes pulses and swaps states instantly (global, §6.1).

**The badge system (v2.3) — four classes, every status chip in the product belongs to exactly one:**

1. **Run-state** — capsule, 20–22px tall, the 11px label step (11px/600/uppercase). The run-status machine only (Draft/Planning/Plan ready/Running/Awaiting approval/Diagnosing/Completed/Failed/Stopped). Colors per the D14 derivation (decisions 2026-07-07): completed = green tint, failed/stopped = red tint, plan_ready/awaiting_approval = amber tint (the human acts), everything else neutral.
2. **Risk** — capsule, 20px tall, the 11px label step. low = FILLED neutral capsule with dark text (must not read disabled), medium = amber tint, high = amber solid (dark text), critical = red solid (white text).
3. **Verdict** — icon-led, 24–28px tall, 12px/600 mixed case: icon + "Pass" / "Fail" / "Needs review" / "Not recorded". The icon is ALWAYS present — color is never the only signal. pass = green, fail = red, needs_review = amber, not-recorded = neutral gray with a dash/hollow icon (NEVER red — absence of evidence is not failure).
4. **Inline step status** — icon + 12.5–13px/500 NEUTRAL text (Succeeded/Active/Pending/Failed/Skipped). The green lives in the check icon, not the word; a timeline of successes reads calm, not lit up.

## 6.3 Layout (the three zones + evidence band, spec §17.2)

The app frame (T6.1b, geometry v2.3): a persistent left sidebar (208px on the navigation surface, collapsible to a 56px icon rail; primary nav, five most recent runs, runner pill) beside a 48px context top bar (route-derived page title at the 15px section step + status badge, right-aligned page actions). The shell sits on the application canvas; all work content sits on white primary surfaces. Each page declares a content width: Home ~1040px and Boards ~960px, both left-aligned (Boards' single-column form reads at a narrower measure; Home is unchanged); composer a ~760px reading column. The frame itself does not scroll (T6.1b): it is a full-height `h-screen`/`overflow-hidden` shell — sidebar and top bar stay put, and only the content region beneath the top bar scrolls, so the page never double-scrolls.

Run Workspace grid: the three-zone split keys on CONTENT width via container query (≥1208px of content area — 280 + 560 + 320 + 2×24 gaps; frame-aware, so the sidebar's 208/56px participates; a viewport breakpoint would overflow the rails under the frame): left Board Context rail 280px · center fluid (min 560px, capped 940px, surplus to the gutters) · right Run Status & Approval rail 320px · bottom Evidence Summary band full-width, 88px collapsed, expands to drawer. Below 1208px of content the right rail stacks under center; this is a desktop tool — mobile is out of scope. The rails are sticky within the content scroll region (`rail-sticky`, T6.2b — the Status card and Stop stay reachable down a long timeline); sticky is disabled below 1208px, where the right rail stacks and a pinned card could otherwise cover the timeline. The evidence drawer opens at 840px, capped at 47vw so the dimmed run always stays visible beside it.

---

# 7. Screen Specifications (MVP screen set, spec §17.6)

Seven screens (Settings added in T6.6). Each lists purpose, content, states, and what "done" means.

Beside the seven product screens, a **/demo route family** (T6.5): `/demo`, `/demo/evidence`, `/demo/report` sit OUTSIDE the app frame in their own read-only DemoShell (a "Demo — replaying a recorded agent run" badge, playback controls, an exit) and replay the bundled fixture through the real Run Workspace / Evidence / Report surfaces — onboarding that works offline. It is a replay, not a run: it issues no runner command (see the demo command-safety ruling in decisions.md, T6.5) — Stop leaves the replay, and Reject (which would end a live run as Stopped) exits with an honest notice since the recording was approved.

## 7.1 Home / Runs

Purpose: land, orient, resume. Content: the runner status pill (online/offline + `runnerKind`) and "New Run" now live in the app frame (T6.1b — the pill moved to the sidebar's foot, New Run to the top bar; the sidebar also carries a quiet "+" beside Runs); the page renders the list of runs — each row: title, board name, status badge, updated-at, **next action** as a real button (Approve plan / Review approval / View evidence / Open report — "Review approval" since v2.0: the row cannot know which proposal is pending, so the label names the user's action, not a guessed hardware step). Sorted: needs-attention first, then active, then recent. States: empty (first-use hero, shown only on a genuine empty response — two actions: **New Run** and **Watch a demo run**, the demo working offline since onboarding often precedes a running runner; the sidebar carries NO demo link on a genuine empty state — the hero owns the affordance — and surfaces its own quiet "Watch a demo run" link only once runs exist, the moment the hero is gone, so two demo affordances never compete on one screen), runner offline (banner with retry + troubleshooting note, list still renders from HTTP), bench needs attention (advisory one-line amber link under the banner slot — "N instruments need attention" → /boards — shown only while the runner is online; never gates New Run), populated. Done when: a user understands what Boardex is working on and what needs them within ten seconds.

## 7.2 New Run Composer

Purpose: delegate a task. Content: the **hero** — a large "Ask Boardex" textarea (placeholder: *"Bring up the BME280 sensor over I2C on this STM32 board. Verify timing and confirm valid temperature/humidity readings over serial."*), board profile selector (context chips below the textarea: Board · Repo · Instruments · Safety — each chip opens the drawer with detail), detected bench readiness inline (compact, from `runner.status`), primary action **Create Run Plan**. Plan renders in place when `run.plan_generated` arrives: numbered plain-language steps, per-step risk badge + hardware-action marker, risk summary line, then **Approve Plan** (primary) / Edit task (secondary, returns to composer). The D12 checklist is a **visible safety gate** (v2.3): a live "N of M bench connections confirmed" line above it, 18px checkboxes on ≥32px row targets, and the disabled primary reading "Approve Plan · N/M confirmed" — switching to plain "Approve Plan" plus a check icon (button-foreground, not the semantic green) at completion. The risk summary sits on a quiet neutral surface carrying a narrow amber left rail only when a medium-or-higher-risk action exists. States: draft, awaiting plan, plan ready, degraded bench (amber inline warning listing the bench's offline/error devices AND any profile instrument no bench device answers to, each with its own copy — "<name> is on the bench but offline/in error" vs. "<reference> was not found on the bench", so an unplugged instrument never reads like a mistyped one; composing allowed, warning repeated at approval adjacent to the D12 checklist). Done when: task → plan → approval works end-to-end against the mock runner with no console errors.

## 7.3 Run Workspace (the core screen)

Purpose: watch and control the active run; embodies §2.2's six states. Layout per §6.3.

- **Left rail — Board Context:** compact card: board name, MCU, repo (basename), instrument list resolved by reference against the live bench (found = green dot + the DEVICE NAME, the thing an operator recognises on the bench — the stable registry id it resolved to lives in the "View details" drawer, where it is the thing you copy into a bug report; degraded = the device's own StatusDot, amber offline / red error; missing = no dot, the profile's reference, amber "<reference> was not found on the bench"; serial resolves by kind; and with NO bench snapshot the list is unknown — no dots, plain instrument names, one neutral "Bench status unavailable." line, matching §7.2: never an assumed anything, since a pessimistic amber reports a healthy instrument as unplugged every time the socket blinks), safety line ("Flash requires approval · Max 3 iterations · Manual power: 3V3 confirmed"), "View details" → drawer with full profile incl. connection checklist.
- **Center — Plan & Progress:** task prompt (collapsed to 2 lines, expandable); the plan as a vertical timeline — each step shows status (pending/active/succeeded/failed), title, and when expanded: summary, artifact chips, and a log pane (LogViewer, per-stream tabs — the five §5.2 streams: agent/build/flash/serial/rtt, the selected tab carrying a 2px accent underline at the seam; log text is never colour-coded, D14). The pane offers an optional per-line timestamp column (each line's `step.log` envelope `ts`, §5.4/v2.2) and client-side find-in-log with match highlighting (T6.2). Active step auto-expanded. Iteration ≥2 renders a divider: "Iteration 2 — applying fix" (driven by the `run.iteration_started` event).
- **Status card dual outcome (v2.4):** once a run is terminal, the status card separates two dimensions directly below the run-state badge (which stays — it IS the run state): *Run execution* — terminal status + `terminalSummary` (the why), and *Validation coverage* — recorded checks vs `registeredChecks` ("2 of 6 checks recorded"), or the no-denominator fallback ("2 checks recorded · no check registry declared") when the stream declared none. The evidence band renders one NEUTRAL gray chip (dash icon, never red) per registered-but-never-recorded expectation; the same split heads the Validation Report (presentation only — the report markdown is the agent's). A budget-killed run whose firmware worked must never read as a hardware failure, and a missing check must never hide inside "Failed".
- **Right rail — Status & Approval (composition v2.3):** the rail reads as its own zone — canvas tone behind white cards, separated from the center by a 1px divider mid-gutter. The **status card sticks at the top**; directly below it sits the **reserved action slot**, ONE stable region whose content swaps in place (zero layout jump when states change): while autonomous, the quiet state — "No approval required · Boardex is executing *[active step title]*", live from RunView; when a gate activates, the approval surface occupies the same slot; on a terminal state, the completion module (status heading + Open Validation Report when the `report_md` artifact exists; a failed/stopped run without one states "Evidence collected so far is retained" — never an empty slot, never a dead end). When `awaiting_approval`, the slot holds the **Approval Card** — proposal title, reason, risk badge, files changed (count, expandable list), hardware actions, buttons Approve & Continue (primary) / Review Diff (opens diff drawer) / Reject. When the pending approval proposes hardware actions and the bench is degraded, the §7.2 warning repeats on the rail (v2.0, Kerem's ruling) — advisory, never gating, and profile-independent: mid-run approvals report the bench's own unhealthy devices only, they never re-resolve profile references. When `diagnosing`: the **Diagnosis Card** — failed checks summarized, ranked hypotheses with confidence labels and evidence links, proposed fix + risk, Approve Fix Plan.
- **Bottom — Evidence Summary band:** one chip per MeasurementCheck (verdict badge + short name, e.g. "I2C clock · PASS"), plus Open Logs / Open Diff / Open Report buttons. Clicking a chip opens Evidence Detail.

States: all six from §2.2 plus `stopped`/`failed` terminal (muted summary + evidence retained). Reconnect: on WS drop show a thin amber "reconnecting" bar; on reconnect, HTTP replay from `lastSeq` then resume WS — no data loss, no duplicate rendering (reducer idempotence by seq). Done when: the full fixture plays start-to-finish with both approvals, the failure/diagnosis pass, iteration 2, and completion — and a mid-run page refresh restores identical state.

## 7.4 Evidence Detail (drawer/panel over the workspace)

Purpose: proof on demand. Tabs per artifact kind: **Checks** (default — table: requirement, expected window, actual value w/ unit, verdict badge, source ref, "view evidence" link; a check's `sourceDoc` makes the source ref a deep link into Sources at the cited document/locator — v2.1/T6.3), **Sources** (v2.1/T6.3 — lists `BoardProfile.documents`; renders the selected one: markdown via the report renderer, PDF via native embed, fail-closed when unfetchable), **Protocol Decode** (monospace table from structured JSON: time, addr, r/w, ack, data, annotation; failed transactions tinted red), **Serial / Build / Flash logs** (LogViewer; navigation v2.3: two compact selectors — Iteration [1|2] × Type [Build|Flash|Serial] — that can never wrap, replacing per-artifact sub-tabs; a cell holds the latest artifact of that kind in that iteration, deep links still land on their exact artifact, and iteration-unresolvable logs stay reachable in an explicit Unassigned list; find-in-log stays directly above the output), **Code Diff** (per-file unified diff, syntax-highlighted, per-file reason line, "Rollback" visible but MVP behavior = instructs runner-side revert only if run non-terminal, else disabled with tooltip), **Raw artifacts** (list with kind, size, Download; logic captures download as sigrok .sr for PulseView). Every check's "view evidence" deep-links to the exact tab + artifact. Done when: every verdict in the fixture is traceable to its artifact in ≤2 clicks.

## 7.5 Board Profile Builder

Purpose: guided, reusable board setup. A single vertical form in 7 sections (not a wizard — engineers scan): Identity (name, MCU) · Firmware (repo path, build/flash/reset commands — monospace inputs) · Serial (port, baud) · Instruments (probe, logic analyzer — free text + detected-device picker from BenchStatus) · Safety (max iterations, flash-requires-approval toggle, power note) · Connection Checklist (repeatable label+detail rows) · Documents (v2.1/T6.3 — repeatable `BoardProfile.documents` metadata rows: id, label, kind, mimeType; metadata only, the runner owns file content). Validate Profile button calls `GET /bench` and marks each referenced device found/missing. Save → `POST /board-profiles`. States: new, editing, validated, device-missing warnings. Done when: a profile created here is selectable in the composer and its checklist renders in the pre-run confirm.

## 7.6 Validation Report

Purpose: the deliverable. The header carries the v2.4 dual-outcome split (Run execution / Validation coverage — presentation only, same derivation as the status card, §7.3). Renders the `report_md` artifact with Boardex styling; sections (generated runner-side, displayed here): Objective · Board & firmware context · Procedure · Measurement results table (with verdicts) · Root cause & fix explanation · Code changes summary · Artifacts index · Reproduction steps. Actions: Copy Markdown, Download .md. Done when: the fixture's completed run yields a report a firmware engineer would attach to a PR without embarrassment.

## 7.7 Settings (T6.6)

Purpose: connection and preferences, one sectioned prose page (reading column) reachable from the sidebar nav and the command palette. Content: **Runner connection** — the runner base URL as a RUNTIME setting (precedence user override > `VITE_RUNNER_URL` > §5.6 default), a Test Connection probe against `/health` reporting online / version-mismatch / degraded / offline inline, and Use-environment-default to clear the override; a change re-points the api singleton and both WS clients (§5.3/§5.4). **Model** — the runner's advertised `capabilities.models`, read-only (the composer's feature-detected picker, §7.2/T6.3, is what actually chooses among them). **Appearance & behavior** — collapse-sidebar-by-default and a replay-onboarding reset (clears the demo tour-seen flag). Persistence is module memory (the sidebar/tour mechanism), so settings live for the session and reset on reload — no storage. States: default (env base, no override), custom override, probe online/offline/version-mismatch. Colors: D14 reserved — only an online probe is green; every failed probe verdict (offline, mismatch, degraded) is an amber warning to resolve, never red. Done when: pointing the UI at a different runner URL at runtime reconnects cleanly with no code change, and the env default still wins when unset.

---

# 8. Sprint Plan with Claude Code Prompts

Conventions for every task: branch `sprint{S}/t{S}.{N}-slug`, atomic commit(s), conventional commit messages, `npm run verify` (typecheck + lint + tests) must pass before a task is declared done. Prompts below are pasted verbatim into Claude Code, prefixed by nothing. Claude Code always has `CLAUDE.md` and this bible available.

## Sprint 0 — Foundation & Contract (goal: fixture replays into a reduced RunView in tests; zero UI yet has to be pretty)

### T0.1 — Repo scaffold + CLAUDE.md

PROMPT:
```
Read docs/BIBLE.md fully before doing anything. You are scaffolding the Boardex monorepo exactly per BIBLE §3. HARD CONSTRAINT: the existing servers/, examples/, docs/*.md (other than files you are told to create), README.md and .gitignore contents belong to the backend owner — do not modify, move, reformat, or lint them. Extend .gitignore additively only (node_modules, dist, coverage).

Tasks:
1. Initialize npm workspaces at the repo root covering packages/*, apps/*, tools/* ONLY (servers/ is Python-land, invisible to npm): packages/contract, apps/ui (Vite react-ts template), tools/mock-runner. TypeScript strict everywhere, shared tsconfig base. ESLint + Prettier, minimal configs.
2. apps/ui: install and configure Tailwind, React Router, Zustand, @tanstack/react-query. Add Inter and JetBrains Mono via @fontsource. Configure the Tailwind theme with the EXACT tokens from BIBLE §6.1 as CSS variables + theme extension. Do not invent additional colors.
3. Root scripts: dev (ui + mock-runner concurrently), verify (typecheck+lint+test across workspaces), test.
4. Create CLAUDE.md at repo root with these operating rules, verbatim in spirit:
   - Read docs/BIBLE.md before any task; the bible overrides your assumptions.
   - Never invent schema fields, event types, routes, or design tokens not in the bible. If something is missing, STOP and ask.
   - No new dependencies without listing them and why at the top of your response.
   - Scope discipline: implement exactly the task, nothing speculative; the Deferred Register (BIBLE §2.3) is off-limits.
   - servers/ and examples/ are the backend owner's domain: read freely, never write.
   - Every task: tests where logic exists, npm run verify green, atomic commits.
   - Colors: green=pass only, red=fail/stop only, amber=approval/warning only.
5. Create docs/decisions.md with a one-line header and today's entry: "Adopted BIBLE v1.0 as source of truth."
Acceptance: npm run verify passes on the empty scaffold; npm run dev starts ui (placeholder page using the token background and Inter) and mock-runner (logs "mock runner listening" only).
Do not build any product UI in this task.
```

### T0.2 — Contract package: schemas, events, commands, reducer

PROMPT:
```
Read docs/BIBLE.md §4 and §5. Implement packages/contract exactly.

Tasks:
1. entities.ts: Zod schemas for every entity in §4 with the exact field names and enums. Export inferred TS types. IDs are strings (ULID format not enforced by schema).
2. events.ts: the envelope schema from §5.1 and a discriminated union over the complete event catalog in §5.2. Payload schemas reference entity schemas.
3. commands.ts: request/response schemas for every route in §5.3, including the 409 error shape.
4. reducer.ts: reduceRun(events) -> RunView exactly as §5.4. Requirements: pure; idempotent by seq (applying a duplicate or lower seq is a no-op); throws a typed ProtocolError on seq gaps; enforces the evidence-linking law (a check.evaluated whose artifactId has no prior artifact.created marks the check needs_review and records a contract warning on RunView.warnings).
5. Emit JSON Schema for events+commands into packages/contract/json-schema/ via a build script (zod-to-json-schema). This output is for the Python runner team.
6. Tests (Vitest): schema round-trips for each event type; reducer unit tests covering: happy transition sequence, duplicate seq, gap detection, approval lifecycle, evidence-law violation.
Acceptance: npm run verify green; json-schema output committed.
Do not create the fixture in this task.
```

### T0.3 — The BME280 fixture + artifacts

PROMPT:
```
Read docs/BIBLE.md §5.5 fully. Author packages/contract/fixtures/bme280_run_001.jsonl and fixtures/artifacts/*.

Requirements:
1. The fixture must tell EXACTLY the 8-beat story in §5.5, using only event types from §5.2, with gapless seq, plausible ISO timestamps (~11 minutes total run), and delayMs pacing that feels like a real bench (builds 8-20s, flash 4-8s, capture 5-10s) — but cap any single delayMs at 20000.
2. Author realistic artifact files: a unified diff for a plausible STM32 I2C address fix (7-bit vs 8-bit shift bug: first iteration uses address 0x76 unshifted where the register write expects it <<1 — make the code and the fix technically coherent; bare-metal register-level style matching examples/firmware, NOT Zephyr/HAL boilerplate); a build log (Make + arm-none-eabi-gcc style, ~30 lines, consistent with examples/firmware/*/Makefile); a flash log (pyOCD style: probe discovery, target connect, flash program/verify lines); iteration-1 serial log showing I2C timeout errors; iteration-2 serial log showing TEMP=24.3 HUM=41.2 lines; a protocol decode JSON shaped like sigrok I2C decoder output (array of transactions: iteration 1 shows NACK on 0x76 writes, iteration 2 shows ACKs and data reads); a timing_measurement JSON ({ measurement:"logic_analyzer.i2c.scl_frequency", valueHz: 99600 }); and the final report_md written per BIBLE §7.6 section list, evidence-linked by artifact label.
3. Every MeasurementCheck in the fixture links a real artifactId from the fixture. The three checks are i2c_clock, device_ack, serial_output with the expected windows from §5.5.
4. Add a fixture validation test: parse every line, validate against the event union, run reduceRun over the stream, and assert: final status completed; 2 approvals resolved; iteration reaches 2; all 3 checks pass at the end; zero RunView.warnings.
Technical accuracy matters: consult servers/ and examples/firmware/ in this repo for the house style (pyOCD, sigrok, RTT, bare-metal Make) before authoring. If you are not certain about a register, pyOCD line, or sigrok output shape, choose the most standard form and add a fixture-notes.md flagging anything a firmware engineer should verify. Do not invent exotic details.
Acceptance: validation test green in npm run verify.
```

### T0.4 — Mock runner

PROMPT:
```
Read docs/BIBLE.md §5.3, §5.5, §5.6. Implement tools/mock-runner as specified — plain Node + TypeScript, ws for WebSocket, node:http (no Express).

Requirements: every route in §5.3; replay semantics, pause-on-plan and pause-on-approval, reject → run.stopped alternate ending, stop-anytime, SPEED env, --degraded flag, afterSeq HTTP replay, artifact serving with MIME types, canned BoardProfile and BenchStatus per §5.6. Validate every outbound event against the contract schemas at send time in dev mode (fail loud). CORS: allow the Vite dev origin.
Tests: integration test that drives a full run over real HTTP+WS (create run, approve plan, approve both approvals, assert terminal completed and event count matches fixture); a reconnect test (drop WS mid-run, HTTP replay from lastSeq, assert no gap/duplicate after resuming); a stop test.
Acceptance: npm run verify green; manual: curl /health returns runnerKind "mock".
```

### T0.5 — Design primitives

PROMPT:
```
Read docs/BIBLE.md §6 fully. Build apps/ui/src/design: every primitive listed in §6.2, using only the §6.1 tokens. Include the risk-badge and verdict-badge mappings exactly. LogViewer must be virtualized (@tanstack/react-virtual), monospace, auto-follow with pause-on-scroll-up and a "jump to latest" affordance.
Build a /design dev-only route rendering every primitive in every state (a plain gallery page, our visual regression baseline).
Tests: rendering + interaction tests for Badge mappings, ConfirmDialog, LogViewer follow behavior.
Acceptance: npm run verify green; gallery renders with zero non-token colors (grep the diff for hex values outside design/tokens as a self-check).
```

## Sprint 1 — Shell, Home, Composer (goal: create a run and approve a plan against the mock runner)

### T1.1 — App shell, providers, transport clients

PROMPT:
```
Read docs/BIBLE.md §5.3, §5.4, §7.1. Build:
1. lib/api.ts: typed HTTP client over the contract command schemas (thin fetch wrapper; parse responses with Zod; surface 409 as a typed StateConflict).
2. lib/ws.ts: WebSocket client with: connect per runId or global; on message, Zod-validate then dispatch; heartbeat/timeout detection; auto-reconnect with backoff; on reconnect, fetch /runs/{id}/events?afterSeq=lastSeq and feed through the same dispatch path before resuming live events.
3. lib/runStore.ts: Zustand store keyed by runId holding ordered events and memoized reduceRun output; the ONLY state derivation path (BIBLE D5).
4. App shell: minimal top bar (Boardex wordmark left; runner status pill right, driven by /health poll + global WS runner.status), React Router routes for /, /runs/new, /runs/:id, /boards, /boards/:id, /design.
Tests: ws client reconnect/replay logic against the mock runner (integration); store idempotence.
Acceptance: verify green; top bar pill correctly reflects mock runner up/down (kill and restart it).
```

### T1.2 — Home / Runs list

PROMPT:
```
Read docs/BIBLE.md §7.1. Build the Home screen exactly as specified: runner pill, New Run button, run rows with next-action buttons, needs-attention-first ordering, empty state, runner-offline banner. Data: GET /runs via TanStack Query + live updates from the global WS. Next-action derivation lives in a pure helper with unit tests (status -> {label, route}).
Acceptance: verify green; with the mock runner seeded, the list shows the canned state; creating a run from another tab appears live.
```

### T1.3 — New Run Composer + plan approval

PROMPT:
```
Read docs/BIBLE.md §7.2 fully. Build the composer as the hero exactly as specified, including context chips backed by the selected BoardProfile, inline bench readiness (amber degraded warning listing offline devices when mock runner runs with --degraded), Create Run Plan -> POST /runs -> navigate to /runs/:id in composer mode -> render plan in place on run.plan_generated -> Approve Plan -> POST plan/approve. Pre-approval, if the profile has a connectionChecklist, show it as a confirm-each-line list (BIBLE D12) gating the Approve button.
Tests: component test for the checklist gate; integration: full composer->plan->approve flow against the mock runner.
Acceptance: verify green; the flow works with keyboard only (tab order sane, Enter submits nothing destructive).
```

## Sprint 2 — Run Workspace (goal: the entire fixture plays live, both approvals, diagnosis, completion, refresh-safe)

### T2.1 — Workspace layout + plan timeline
### T2.2 — Approval card + diagnosis card + stop
### T2.3 — Evidence summary band + reconnect hardening

PROMPTS (same discipline; each begins "Read docs/BIBLE.md §7.3..."):
```
T2.1: Build the three-zone workspace grid (§6.3) with left Board Context rail and the center plan timeline per §7.3: step states, active auto-expand, per-stream log tabs feeding from step.log events via the store, artifact chips, iteration divider. No approval UI yet.
Acceptance: fixture plays with SPEED=5; timeline reflects every step transition; logs stream into the correct tabs; no dropped or duplicated lines across a manual reload mid-run.

T2.2: Build the right rail per §7.3: status card with elapsed timer and Stop Run (ConfirmDialog; POST stop; handle 409 as refresh); the Approval Card wired to approval.requested/resolved incl. Reject -> stopped ending; the Diagnosis Card with ranked hypotheses, confidence labels, evidence links (stub links to be wired in Sprint 3 as /runs/:id/evidence?artifact=...), and Approve Fix Plan (which is approval approve on the fix approval).
Acceptance: full fixture playthrough start-to-finish using only the UI; reject path produces the stopped terminal state cleanly.

T2.3: Build the bottom evidence band per §7.3 (check chips live from check.evaluated) and harden reconnect: implement the amber reconnecting bar, kill/restart the mock runner mid-run in an integration test and assert identical RunView afterward (reducer lastSeq path). Add a Playwright smoke test: seed fixture, drive the whole run through the browser, assert the completed state and 3 passing chips.
Acceptance: verify green including the Playwright smoke.
```

## Sprint 3 — Evidence Layer (goal: every verdict traceable to its artifact in ≤2 clicks)

### T3.1 — Evidence Detail drawer: Checks + Protocol Decode
### T3.2 — Logs + Code Diff (with per-file reasons, rollback affordance rules) + Raw artifacts
### T3.3 — Deep links from checks/diagnosis/approval to exact evidence

PROMPT SKELETON:
```
Read docs/BIBLE.md §7.4. Build [tabs]. Content is fetched by artifact reference (GET /artifacts/{id}), parsed for structured kinds (protocol_decode, timing_measurement, code_diff) with Zod, rendered per spec. Diff rendering: use a lightweight diff renderer (react-diff-view or hand-rolled unified view — justify choice in one paragraph before coding). Failed decode transactions tinted with the fail bg tint only.
Acceptance: from the fixture's failed device_ack check, a user reaches the exact NACK rows in ≤2 clicks; every artifact downloads with the right filename.
```

## Sprint 4 — Board Profile Builder + Bench (goal: real profile round-trip)

### T4.1 — Profile form per §7.5, validate-against-bench, save round-trip; T4.2 — pre-run checklist integration polish + degraded-bench flows end-to-end.

## Sprint 5 — Report, History, Real Runner (goal: swap runners with zero UI changes)

### T5.1 — Validation Report view + Markdown copy/download per §7.6.
### T5.2 — Run history: terminal runs render fully from HTTP event replay (no WS), proving the event-sourcing bet.
### T5.3 — Real-runner integration + backend conformance audit (see §10). This is the joint task with the cofounder; UI changes REQUIRED to be zero — any needed UI change is by definition a contract bug and gets fixed in the contract + mock first.

## Sprint 6 — UI Excellence (goal: the UI reads as a designed product; Documents/Sources lands as contract v2.1)

Protocol for this sprint: T6.1/T6.2/T6.4/T6.5 run the **light loop** — build → Kerem's screenshot review → iterate — with one sprint-level adversarial review (§9.2) at the end covering all four. T6.3 and T6.6 touch the contract surface and keep the full per-task protocol (§9.1/§9.2).

### T6.1 — Design language v2
Evolved type scale and rhythm; an elevation + focus-state system; motion tokens (durations/easings for run-state transitions); timeline status iconography; the /design gallery updated as the new visual-regression baseline. D14 color reservations are non-negotiable.

### T6.2 — Workspace as theater
Timeline motion on step transitions; active-step live treatment; LogViewer upgrades (timestamps, per-stream accents within token law, find-in-log); Progress wired into the StatusCard (steps completed); artifact chips animating in as evidence lands; the evidence-band verdict-flip moment.

### T6.3 — Documents & Sources (full protocol; contract v2.1 via PR to the backend owner)
`BoardProfile.documents?: BoardDocument[]`; `GET /documents/{id}` (+ `/meta`) by reference; `MeasurementCheck.sourceDoc?: { documentId, locator? }` — the resolvable form of a citation beside the free-text `sourceRef` (the fallback). Runner-capabilities fields ride along for T6.6 (`/health.capabilities.models`, `CreateRun.model`, `Run.model`). The mock serves a real datasheet excerpt + schematic notes and advertises `capabilities.models`. UI (stage 2): a Sources tab in the evidence drawer rendering the profile's documents; check citations deep-link to the exact document at the locator; a Documents section in the Board Profile Builder (metadata only); a composer model select (feature-detected). (Design settled during T6.3: `sourceDoc` on the check supersedes the originally-sketched `source_excerpt` artifact kind — a citation is a pointer into profile-owned reference material, not per-run evidence; see decisions.md.)

### T6.4 — Command palette & keyboard-first
⌘K palette (navigate runs/boards/evidence; actions navigate to their surface — approvals still require their card); global shortcuts; visible focus order.

### T6.5 — First-run experience & demo mode
Onboarding empty states; "Watch a demo run" replaying the fixture as a guided, self-narrating tour.

### T6.6 — Settings + model selection (gated on the runner-capabilities contract proposal riding in T6.3's PR)
Runner URL setting replacing the baked env var; a model picker in the composer; model attribution in the report.

---

# 9. Working Protocol (the entire "process" we keep — nothing else)

## 9.1 Task loop
For every task: paste the prompt → Claude Code implements on a branch → `npm run verify` green → adversarial review (§9.2) → Kerem reviews UI in browser → merge. One task per session where possible; always `/clear` or a fresh session between build and review.

## 9.2 Fresh-context adversarial review (paste after every task, in a NEW session)

```
You are a read-only adversarial reviewer. Do not edit any file.
Read docs/BIBLE.md, then the diff of the last merge-candidate branch vs main.
Judge ONLY against: (1) the task's acceptance criteria, (2) BIBLE contract §4-5 exactness (any invented field, event, route, or token is a blocking finding), (3) the Deferred Register §2.3 (any speculative implementation is a finding), (4) test honesty (do tests assert behavior or merely execute code?), (5) the evidence-linking law, (6) color-semantics rules.
Output the merge report:
Verdict: MERGEABLE | FIX_FIRST | BLOCKED
Findings: severity / file / evidence / required fix
Checks: contract exact: y/n · scope clean: y/n · tests honest: y/n · tokens only: y/n
Next recommended task.
```

FIX_FIRST → feed findings back to a build session; repeat until MERGEABLE. Kerem is the final gate on anything visual — reviewers do not judge taste.

## 9.3 Decision log
Any deviation from this bible (schema change, cut, addition) = one line in docs/decisions.md + edit the bible itself. The bible never silently drifts from the code.

---

# 10. Backend Integration Contract (for the cofounder — hand him §5 + this section)

## 10.0 Where the contract lives in his architecture
His MCP servers (boardex-target, boardex-logic) are the tool execution layer and stay exactly as they are — the contract does NOT apply to them. The contract applies to the **orchestrator service** (`servers/boardex-runner`, built): its `AgentBench` (`BENCH=agent`, per docs/RUNNER_AGENT_V0_SPEC.md) runs the agent loop that plans a run, calls the MCP tools behind harness-enforced approval gates, and translates what happens into the §5 event stream + command API — alongside the scripted `FakeBench`/`RealBench` arcs. MCP is an internal dialect behind the orchestrator; the UI never sees it. Practical consequence: he can keep developing/debugging his servers interactively via Claude Code today, and the orchestrator spawns that same tool surface per run once a plan is approved.

## 10.1 What the orchestrator service must provide
Exact conformance to §5: every route in §5.3 with identical shapes; the event catalog of §5.2 with gapless per-run seq; artifacts by reference with correct MIME types (logic captures as sigrok .sr; decodes as structured JSON); HTTP event replay via afterSeq; 409 semantics for invalid-state commands; `/health` reporting `contractVersion: "boardex-contract/0.1"` and `runnerKind: "real"`. The JSON Schema emitted by the contract package (packages/contract/json-schema/) is his machine-readable spec — he should validate every outbound event against it in his test suite, exactly as the mock runner does. RTT and UART both map to step.log streams ('rtt' / 'serial').

## 10.2 Non-negotiable behaviors
1. **Events are truth.** The runner may keep any internal state it wants, but everything the UI needs must be expressible as the §5.2 events. If his agent loop produces information with no event type, we extend the contract first (bible edit + mock + fixture), then he emits it.
2. **Approvals actually block.** `approval.requested` must halt hardware actions until the HTTP resolution arrives. The UI assumes nothing risky happens while an approval is pending.
3. **Stop is honored fast.** POST stop → hardware-safe halt → `run.stopped` within seconds, never "after the current 90s capture finishes" without an interim status event.
4. **Artifacts are durable and addressable** for the lifetime of the run history; the report references them by id.
5. **Log volume discipline:** batch step.log lines (≤10Hz flush) rather than one WS frame per line.

## 10.3 Recording a real fixture
Once his runner works, he records a genuine BME280 run by teeing every emitted event (plus wall-clock deltas as delayMs) to a .jsonl in the fixture format. That file replaces the authored fixture in packages/contract/fixtures; the fixture validation test from T0.3 must still pass unmodified. From then on, demos replay reality.

## 10.4 Integration checklist (T5.3, run together)
1. `GET /health` from the UI shows real + matching contract version (mismatch = hard error banner, by design).
2. Contract conformance suite: point the mock-runner integration tests' base URL at his runner; create-run/approve/stop tests must pass unchanged (task-prompt handling differences allowed via a canned test profile on his side).
3. Live run end-to-end on the bench with the UI driving both approvals.
4. Mid-run UI refresh restores state (his afterSeq replay works).
5. Kill the WS, verify reconnect.
6. Adversarial audit of his repo (the one legitimate multi-agent job): parallel read-only reviewers for (a) contract conformance, (b) approval-gating correctness — can any code path flash without a resolved approval?, (c) stop-path safety, (d) blocking-call hygiene in the event loop, (e) secrets/paths hygiene. Findings feed his backlog; blocking findings block the demo, not the merge of UI code.

## 10.5 Contract evolution rule
The contract only changes by: bible §5 edit → contract package change + version bump → mock runner + fixture updated → UI updated → THEN the real runner. Never the reverse order. He never "just adds an event type" — the UI ignoring unknown events (§5.1) is a safety net, not a workflow.

---

# 11. Definition of MVP-Done (exit criteria)

1. A stranger given the app cold creates a run, approves the plan and both hardware approvals, watches the failure→diagnosis→fix arc, and explains afterward what happened and where the proof is — without help.
2. The fixture demo runs flawlessly at SPEED=1 and SPEED=5.
3. Real-runner integration passed the §10.4 checklist on the physical bench.
4. Every MeasurementCheck in a completed run links to fetchable evidence.
5. The exported Markdown report is PR-attachable without embarrassment.
6. `npm run verify` green; Playwright smoke green; zero non-token colors; zero Deferred-Register leakage.

*End of bible. Edit deliberately, log every edit, and go build.*
