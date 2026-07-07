# BOARDEX UI BIBLE
## Master Build Document for the Boardex Desktop MVP — UI, Contracts, and Claude Code Execution Plan

Version 1.3 · July 2026 — v1.2 contract amendments per §10.5: added `run.iteration_started` event (fix-loop iteration was unrepresentable); removed `nextAction` from RunSummary (UI-derived per T1.2); BenchStatus devices carry the backend registry's stable `id`. v1.3: RunView gains `riskSummary?` populated from `run.plan_generated` (reducer-only change; wire contract unchanged).
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
  sourceRef?: string                       // e.g. "BME280 datasheet §6.2"
}

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
  knownQuirks: string[] }

BenchStatus = { runnerOnline: boolean, contractVersion: string,
  devices: { id: string,    // backend registry's stable device_id, e.g. "sigrok:kingst-la2016:conn=3.12"
             kind: 'debug_probe'|'serial'|'logic_analyzer',
             name: string, state: 'online'|'offline'|'error', detail?: string }[] }
```

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

Rules: `seq` is per-run and gapless — the UI treats a gap as a protocol error and re-fetches via HTTP replay. Events are immutable and append-only. Unknown event types must be ignored by the UI (forward compatibility), but unknown types appearing in review of the mock runner are a failure (backward discipline).

## 5.2 Event catalog (complete for MVP)

| type | payload (summary) | emitted when |
|---|---|---|
| `run.created` | `{ run: Run }` | run row exists |
| `run.plan_generated` | `{ plan: PlanStep[], riskSummary: string }` | plan ready for approval |
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
GET  /health                         -> { ok, contractVersion, runnerKind: 'mock'|'real' }
GET  /bench                          -> BenchStatus
GET  /board-profiles                 -> BoardProfile[]
POST /board-profiles                 -> create/update BoardProfile
GET  /runs                           -> RunSummary[]  (id, title, status, boardProfileId, updatedAt)
POST /runs                           { taskPrompt, boardProfileId }        -> { runId }
POST /runs/{id}/plan/approve         {}                                     -> 204
POST /runs/{id}/approvals/{aid}      { status: 'approved'|'rejected' }      -> 204
POST /runs/{id}/stop                 {}                                     -> 204
GET  /runs/{id}/events?afterSeq=N    -> Event[]        (HTTP replay for reconnect/history)
GET  /artifacts/{id}                 -> content (Content-Type per artifact.mimeType)
GET  /artifacts/{id}/meta            -> Artifact
WS   /ws?runId={id}                  -> event stream for one run (server pushes; client sends nothing)
WS   /ws?global=1                    -> runner.status + run.created + run.status_changed for all runs (dashboard)
```

Command errors: HTTP 409 with `{ error, currentStatus }` when a command is invalid for the run's state (e.g. approving an already-resolved approval). The UI must render 409s as state refresh, not as crashes.

## 5.4 The reducer (contract-owned, UI-consumed)

`packages/contract/src/reducer.ts` exports:

```ts
reduceRun(events: Event[]): RunView
// RunView = { run, steps[], artifacts[], checks[], approvals[],
//             diagnosis?, riskSummary?: string, logsByStep: Map, lastSeq }
```

Pure, deterministic, unit-tested against the fixture. `riskSummary` is populated from `run.plan_generated` and is undefined before the plan exists. The UI NEVER derives run state any other way — if the UI needs data RunView lacks, extend RunView via the reducer; never read the event list directly.

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

---

# 6. Design System

## 6.1 Tokens (Tailwind theme extension — exact values)

```
Background:        #FAFAF9  (app)    #FFFFFF (panels/cards)
Border:            #E7E5E4  (1px, never darker than #D6D3D1)
Text primary:      #1C1917
Text secondary:    #57534E
Accent (actions):  #4F46E5  (indigo-600); hover #4338CA
Pass/success ONLY: #16A34A  (green-600); bg tint #F0FDF4
Fail/stop ONLY:    #DC2626  (red-600);   bg tint #FEF2F2
Approval/warn ONLY:#D97706  (amber-600); bg tint #FFFBEB
Neutral badge:     #78716C on #F5F5F4
Radius: 10px cards, 8px buttons/inputs. Shadows: subtle only
  (0 1px 2px rgba(0,0,0,0.05)); depth comes from borders + whitespace, not shadows.
Spacing rhythm: 4px base; panels padded 20–24px; sections separated 32px.
Type: Inter (UI), JetBrains Mono (logs, diffs, values, commands).
Scale: 13px meta, 14px body, 16px section titles, 20px page titles,
  22–24px only for the Ask Boardex composer placeholder.
```

Hard rules: green/red/amber are semantically reserved (D14) — never decorative. One accent. No gradients, no glassmorphism, no dark mode in MVP. Density: calm by default; monospace areas (logs, decode tables) may be dense.

## 6.2 Primitives to build once (design/):

`Button` (primary/secondary/danger/ghost) · `Card` · `Badge` (risk: low/medium/high/critical; verdict: pass/fail/needs_review; status) · `StatusDot` (online/offline/error) · `KeyValue` row · `Progress` (thin bar) · `LogViewer` (virtualized, monospace, auto-follow with pause-on-scroll) · `EmptyState` · `ConfirmDialog` · `Drawer` (right-side, for details-on-demand)

Risk badge mapping: low = neutral, medium = amber outline, high = amber solid, critical = red solid. Verdict mapping: pass = green, fail = red, needs_review = amber.

## 6.3 Layout (the three zones + evidence band, spec §17.2)

Run Workspace grid on desktop (≥1280px): left Board Context rail 280px · center fluid (min 560px) · right Run Status & Approval rail 340px · bottom Evidence Summary band full-width, 88px collapsed, expands to drawer. Below 1280px the right rail stacks under center; this is a desktop tool — mobile is out of scope.

---

# 7. Screen Specifications (MVP screen set, spec §17.6)

Six screens. Each lists purpose, content, states, and what "done" means.

## 7.1 Home / Runs

Purpose: land, orient, resume. Content: runner status pill (online/offline + `runnerKind`), "New Run" primary button, list of runs — each row: title, board name, status badge, updated-at, **next action** as a real button (Approve plan / Approve flash / View evidence / Open report). Sorted: needs-attention first, then active, then recent. States: empty (first-use hero pointing to New Run), runner offline (banner with retry + troubleshooting note, list still renders from HTTP), populated. Done when: a user understands what Boardex is working on and what needs them within ten seconds.

## 7.2 New Run Composer

Purpose: delegate a task. Content: the **hero** — a large "Ask Boardex" textarea (placeholder: *"Bring up the BME280 sensor over I2C on this STM32 board. Verify timing and confirm valid temperature/humidity readings over serial."*), board profile selector (context chips below the textarea: Board · Repo · Instruments · Safety — each chip opens the drawer with detail), detected bench readiness inline (compact, from `runner.status`), primary action **Create Run Plan**. Plan renders in place when `run.plan_generated` arrives: numbered plain-language steps, per-step risk badge + hardware-action marker, risk summary line, then **Approve Plan** (primary) / Edit task (secondary, returns to composer). States: draft, awaiting plan, plan ready, degraded bench (amber inline warning listing offline devices; composing allowed, warning repeated at approval). Done when: task → plan → approval works end-to-end against the mock runner with no console errors.

## 7.3 Run Workspace (the core screen)

Purpose: watch and control the active run; embodies §2.2's six states. Layout per §6.3.

- **Left rail — Board Context:** compact card: board name, MCU, repo (basename), instrument list with StatusDots, safety line ("Flash requires approval · Max 3 iterations · Manual power: 3V3 confirmed"), "View details" → drawer with full profile incl. connection checklist.
- **Center — Plan & Progress:** task prompt (collapsed to 2 lines, expandable); the plan as a vertical timeline — each step shows status (pending/active/succeeded/failed), title, and when expanded: summary, artifact chips, and a log pane (LogViewer, per-stream tabs: agent/build/flash/serial). Active step auto-expanded. Iteration ≥2 renders a divider: "Iteration 2 — applying fix" (driven by the `run.iteration_started` event).
- **Right rail — Status & Approval:** current status card (status badge, elapsed, Stop Run — danger, always visible while non-terminal, with ConfirmDialog). When `awaiting_approval`: the **Approval Card** — proposal title, reason, risk badge, files changed (count, expandable list), hardware actions, buttons Approve & Continue (primary) / Review Diff (opens diff drawer) / Reject. When `diagnosing`: the **Diagnosis Card** — failed checks summarized, ranked hypotheses with confidence labels and evidence links, proposed fix + risk, Approve Fix Plan.
- **Bottom — Evidence Summary band:** one chip per MeasurementCheck (verdict badge + short name, e.g. "I2C clock · PASS"), plus Open Logs / Open Diff / Open Report buttons. Clicking a chip opens Evidence Detail.

States: all six from §2.2 plus `stopped`/`failed` terminal (muted summary + evidence retained). Reconnect: on WS drop show a thin amber "reconnecting" bar; on reconnect, HTTP replay from `lastSeq` then resume WS — no data loss, no duplicate rendering (reducer idempotence by seq). Done when: the full fixture plays start-to-finish with both approvals, the failure/diagnosis pass, iteration 2, and completion — and a mid-run page refresh restores identical state.

## 7.4 Evidence Detail (drawer/panel over the workspace)

Purpose: proof on demand. Tabs per artifact kind: **Checks** (default — table: requirement, expected window, actual value w/ unit, verdict badge, source ref, "view evidence" link), **Protocol Decode** (monospace table from structured JSON: time, addr, r/w, ack, data, annotation; failed transactions tinted red), **Serial / Build / Flash logs** (LogViewer), **Code Diff** (per-file unified diff, syntax-highlighted, per-file reason line, "Rollback" visible but MVP behavior = instructs runner-side revert only if run non-terminal, else disabled with tooltip), **Raw artifacts** (list with kind, size, Download; logic captures download as sigrok .sr for PulseView). Every check's "view evidence" deep-links to the exact tab + artifact. Done when: every verdict in the fixture is traceable to its artifact in ≤2 clicks.

## 7.5 Board Profile Builder

Purpose: guided, reusable board setup. A single vertical form in 6 sections (not a wizard — engineers scan): Identity (name, MCU) · Firmware (repo path, build/flash/reset commands — monospace inputs) · Serial (port, baud) · Instruments (probe, logic analyzer — free text + detected-device picker from BenchStatus) · Safety (max iterations, flash-requires-approval toggle, power note) · Connection Checklist (repeatable label+detail rows). Validate Profile button calls `GET /bench` and marks each referenced device found/missing. Save → `POST /board-profiles`. States: new, editing, validated, device-missing warnings. Done when: a profile created here is selectable in the composer and its checklist renders in the pre-run confirm.

## 7.6 Validation Report

Purpose: the deliverable. Renders the `report_md` artifact with Boardex styling; sections (generated runner-side, displayed here): Objective · Board & firmware context · Procedure · Measurement results table (with verdicts) · Root cause & fix explanation · Code changes summary · Artifacts index · Reproduction steps. Actions: Copy Markdown, Download .md. Done when: the fixture's completed run yields a report a firmware engineer would attach to a PR without embarrassment.

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
His MCP servers (boardex-target, boardex-logic) are the tool execution layer and stay exactly as they are — the contract does NOT apply to them. The contract applies to the **orchestrator service** (`servers/boardex-runner`, to be built): the agent loop that plans a run, calls the MCP tools, and translates what happens into the §5 event stream + command API. MCP is an internal dialect behind the orchestrator; the UI never sees it. Practical consequence: he can keep developing/debugging his servers interactively via Claude Code today, and the orchestrator wraps that same tool surface when it's time.

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
