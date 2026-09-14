# boardex-runner ⇄ UI Integration — One-Pager

Audience: the runner maintainer. Scope: bring the UI up against your runner and pass conformance. Authority: `docs/BIBLE.md` §5 (wire contract, v2.0) and §10. Machine-readable spec: `packages/contract/json-schema/` (`events`, `commands`, `artifacts`). The mock (`tools/mock-runner`) is the reference implementation — when prose is ambiguous, its behavior is the tiebreaker.

## 1. Boot

```bash
npm install && npm run verify          # sanity: contract + UI + mock suites green
VITE_RUNNER_URL=http://localhost:<your-port> npm run dev -w apps/ui
```

UI talks to exactly one base URL: your HTTP routes + `WS /ws?runId={id}` and `WS /ws?global=1`. First gate: `GET /health` → `{ ok, contractVersion, runnerKind: "real" }`. `contractVersion` must be the exact string `boardex-contract/0.1` — the `CONTRACT_VERSION` export from `packages/contract` (the bible's v2.0 is a document version; the wire string did not move). The conformance suite (§3) asserts it verbatim against `/health`. Note the UI itself currently gates only on `ok`/`runnerKind` — the version-mismatch hard-error banner is a §10.4 integration-checklist item, not yet wired.

## 2. Wire semantics the UI actually enforces

- **Envelope**: `{seq, runId, ts, type, payload}`. `seq` per-run, gapless, from 1. The store parks on a gap and never renders past it. `ts` may be naive ISO.
- **First known event must be `run.created`.** A known-typed stream starting otherwise is a protocol error client-side. Unknown event types are tolerated (envelope counts toward seq, payload discarded) — that's forward-compat insurance, not a workflow; new types go through §10.5 (bible → contract → mock → UI → you).
- **§5.7 transition graph is normative.** The one MUST: report `plan_ready` before blocking on plan approval, or the UI never offers the button and you deadlock. Terminal = `run.completed|failed|stopped` (dedicated events) **and** they must also appear on the global stream (§5.3 v2.0); `status_changed(terminal)` alone is legal but emit the dedicated event too.
- **Approvals block.** After `approval.requested`, no hardware action until the HTTP resolution lands. The UI's safety model assumes this absolutely.
- **Stop is fast.** `POST /runs/{id}/stop` → hardware-safe halt → `run.stopped` within seconds; emit an interim status if a capture must drain.
- **Replay is your history API.** `GET /runs/{id}/events?afterSeq=N` serves the full log for the run's lifetime — the UI cold-loads terminal runs from it with **no socket**; refusing WS for archived runs is fine. Unknown run id → **404** (the UI fail-closes on it; any other behavior loops).
- **409** `{ error, currentStatus }` for commands invalid in the current state (double-approve, second stop). The UI swallows and re-syncs.
- **Artifacts by reference**, never inline: `artifact.created` → `GET /artifacts/{id}` with correct MIME (`logic_capture` → sigrok `.sr`). Structured kinds (`protocol_decode`, `code_diff`, `timing_measurement`) must validate against `artifacts.schema.json` — the decode shape **is your `parse.py` output** (`{raw,start,end,decoder,text}` annotations + `parse_transactions` transactions), reconciled in v2.0. `report_md` is rendered as untrusted input (schemes sanitized) — optional on failed runs.
- **`step.log`** streams: `build|flash|serial|rtt|agent`; batch (`lines[]`, ≤10 Hz flush). Every `MeasurementCheck.artifactId` must resolve — the evidence-linking law downgrades unresolved checks to `needs_review` with inert links.

## 3. Conformance = run our tests against you

1. **Validate every outbound event** against `json-schema/events.schema.json` in your own test suite (the mock does this at send time; do the same).
2. **Point the mock's integration suite at your runner** (`tools/mock-runner/src/server.test.ts` — parameterize the base URL; a canned test board profile on your side stands in for the fixture): create→plan→approve→approve→terminal, replay-after-drop gapless, stop, reject→stopped, 404, artifact MIME.
3. **Drive one live run through the browser** — both approvals via the UI, mid-run F5 (your `afterSeq` replay restores state), kill the WS once (reconnect).

## 4. Record the fixture (§10.3)

Tee every emitted event plus wall-clock deltas as `{"delayMs":N,"event":{...}}` per line → drop it in `packages/contract/fixtures/` — `npm run test -w packages/contract` must pass **unmodified**. From then on, demos replay your bench.

## 5. Open proposals (your call, small)

`Approval.proposal.diffArtifactId?` (bind gate→diff) · mock honoring `POST /runs` `boardProfileId` (§5.6) · source-excerpt artifact kind for datasheet citations. All optional fields; answer on the integration call.
