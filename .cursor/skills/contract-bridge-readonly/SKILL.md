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
  missing, STOP and draft a proposed BIBLE §5 edit for the UI owner (Kerem) —
  contract changes flow UI-first (§10.5: bible → contract pkg → mock runner →
  UI → our runner). Do not "just emit" it.
- Any accepted deviation = one appended line in `docs/decisions.md`.
- The MCP servers (`boardex-core`/`-target`/`-logic`) are NOT bound by this
  contract (BIBLE §10.0); it binds only the future `servers/boardex-runner`.

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
