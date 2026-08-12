---
name: contract-bridge-readonly
description: How the backend side consumes the Boardex UI contract (event stream, command API, JSON Schema) without ever editing it. Use when working on servers/boardex-runner, deciding which event to emit, validating events against the schema, or when a needed event/route/field seems to be missing from the contract.
---

# Consuming the UI contract from the backend side (read-only)

The two sides of Boardex meet ONLY at the contract in `docs/BIBLE.md` §5
(WebSocket event stream + HTTP command API). We consume it; we never edit it.

## Sources of truth, in order

1. `docs/BIBLE.md` §5 — the human-readable contract (events §5.2, routes §5.3).
2. `packages/contract/json-schema/` — the emitted JSON Schema. This is the
   machine-readable spec for Python; read these files freely.
3. `docs/decisions.md` — append-only log of accepted deviations.

Never import from `packages/contract` TypeScript or read its Zod sources as
spec — the emitted JSON Schema is the only cross-language bridge.

## Hard rules

- **Never edit** `packages/contract/*`, `docs/BIBLE.md`, `apps/ui/*`, or
  `tools/mock-runner/*`. Read-only, always.
- **Never invent** event types, routes, or fields. If a needed event is
  missing, STOP and draft a proposed BIBLE §5 edit for the UI owner —
  contract changes flow UI-first (§10.5: bible → contract pkg → mock runner →
  UI → our runner). Do not "just emit" it.
- Any accepted deviation = one appended line in `docs/decisions.md`.
- The MCP servers (`boardex-core`/`-target`/`-logic`) are NOT bound by this
  contract (BIBLE §10.0); it binds only the future `servers/boardex-runner`.

## v2.0 enforcement details the UI actually applies (from the UI owner's one-pager)

These are client-side behaviors; violating them deadlocks or fail-closes the UI
even when every individual event is schema-valid.

- **Envelope-first seq counting**: every well-formed envelope counts toward seq
  continuity, even unknown-typed ones (payload discarded). "Ignore" never means
  "drop" — a gap parks the store and nothing past it renders. This applies to
  the HTTP replay body too: an unknown-typed event must not fail the response.
- **First KNOWN event must be `run.created`**, in the live stream and in every
  replay — including the edge where a stop beats run creation: emit
  `run.created` first, then the stopped ending (the mock does exactly this).
- **§5.7 transition graph is normative.** The one MUST: report `plan_ready`
  (via `run.status_changed`) BEFORE blocking on plan approval, or the UI never
  offers the approve button and the run deadlocks.
- **Dedicated terminal events** (`run.completed|failed|stopped`) end the run
  and MUST also reach the global stream (§5.3 v2.0). `status_changed(terminal)`
  alone is legal but emit the dedicated event too; nothing may follow it.
- **404 fail-close**: unknown run id → 404 on every run route (the UI
  fail-closes on it; any other status loops). **409 re-sync**: invalid-state
  command → `{ error, currentStatus }`; the UI swallows it and refreshes.
- **Approvals block absolutely**: after `approval.requested`, no hardware
  action until the HTTP resolution lands.
- **Replay is the history API**: `GET /runs/{id}/events?afterSeq=N` serves the
  full log for the run's lifetime; terminal runs cold-load from it with no
  socket (refusing WS for archived runs is allowed).
- **Decode shape = the house parser output**: `protocol_decode` annotations are
  exactly `parse.py::parse_annotations` lines (`{raw, start?, end?, decoder?,
  text}` with `raw == "{start}-{end} {decoder}: {text}"`), transactions exactly
  `decode/i2c.py::parse_transactions`. Serve the pipeline output verbatim.
- **Every `MeasurementCheck.artifactId` must resolve** — unresolved checks are
  downgraded to `needs_review` with inert links (evidence-linking law).
- **§10.3 fixture format**: one `{"delayMs": N, "event": {...}}` per line
  (delayMs ≤ 20000), artifact bodies as `artifacts/<artifactId>.<ext>` files
  with sizes matching `sizeBytes`. The contract package's fixture test is the
  acceptance gate and must pass unmodified.

## When building `servers/boardex-runner` (BIBLE §10.2)

- **Events are truth**: everything the UI needs must be expressible as a §5.2
  event, append-only with gapless per-run `seq`.
- **Approvals actually block**: `approval.requested` halts hardware until the
  HTTP resolution arrives.
- **Stop is honored fast**: `POST /stop` → hardware-safe halt → `run.stopped`
  within seconds.
- **Artifacts are by reference**, durable and addressable for the run's history
  lifetime — never embedded in events. Logic captures are sigrok `.sr`;
  decodes are structured JSON.
- **Batch `step.log`** at ≤10Hz flush, never one WS frame per line. RTT maps to
  the `rtt` stream, UART to `serial`.
- `/health` returns `contractVersion: "boardex-contract/0.1"` and
  `runnerKind: "real"`.
- **Validate every outbound event** against `packages/contract/json-schema/`
  in the test suite, exactly as the mock runner does. HTTP event replay via
  `afterSeq`; 409 for commands invalid in the current run state.

`servers/boardex-runner` now exists and implements all of the above: the
schema bridge lives in `boardex_runner/contract.py` (validates every outbound
event and structured artifact body at emit time), the §5.7 graph in
`boardex_runner/engine.py`. For running it and pointing the UI or the mock
suite at it, see the `runner-conformance` skill.
