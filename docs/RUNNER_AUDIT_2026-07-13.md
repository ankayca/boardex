All 33 runner tests pass. Mock and runner match byte-for-byte on stop/reject (both emit status_changed{stopped} then run.stopped), so that's conformant, not a finding. I have everything I need across all six angles.

---
Adversarial audit — servers/boardex-runner (§10.4 item 6)

Subject: the orchestrator service only. Read-only; no files touched. Verified by reading every emit path, static trace of the real_bench hardware path against boardex-target/boardex-logic, and executing the fake-bench pytest suite (33 passed).

Runner structure (five lines, so the findings track)

1. server.py — aiohttp app: the §5.3 routes, CORS, and WS fan-out (one asyncio.Queue per client drained by a writer task); state_from_env() wires BENCH=fake|real.
2. engine.py — RunEngine, one per run: owns the event log, the §5.7 status machine, the approval/plan gates (an asyncio.Future), and the pipeline task. Bench work is pushed to an executor via _call; commands run on the loop thread.
3. bench.py + fake_bench.py + real_bench.py — the Bench protocol (scripted BME280 story) and its two implementations; RealBench drives pyOCD + sigrok in-process, blocking = True.
4. events.py + contract.py + artifacts.py — gapless-seq append-only log that schema-validates every outbound event, the §5.7 transition table, and the by-reference artifact store.
5. clock.py + recorder.py — virtual/wall clocks for pacing, and the §10.3 fixture tee.

---
Findings (severity-ranked)

HIGH-1 · Real bench is a process-wide singleton; concurrent runs corrupt shared state and share one probe — angles (b)(c)(d)

state_from_env() builds bench = RealBench(config) once and hands every run bench_factory=lambda: bench. The fake path returns a fresh FakeBench per run (lambda: FakeBench(...)), so this asymmetry is invisible to the entire test suite by construction. On real hardware, two POST /runs yield two RunEngines sharing one RealBench: self._evidence (keyed only by iteration) and self._session_id collide — run B's iteration-1 capture overwrites run A's evidence, and B's read_serial reuses A's open RTT session against B's ELF. The approval gate guarantees a run never flashes without its own approval, but it does not make the bench quiescent while any approval is pending: run B can flash()/reset the shared probe while run A sits at its flash approval. Nothing serializes runs.
Fix: a single-active-run mutex (reject/queue a second POST /runs on the real bench with 409), or per-run bench instances with hardware arbitration. At minimum, refuse to start a run while another is non-terminal on blocking benches.

HIGH-2 · GET /bench and every global-WS connect run a live hardware scan on the event loop — angle (d)

For the real bench, state_from_env() leaves _bench_status = None, so RunnerApp.bench_status() falls through to self.bench_factory().bench_status(), which calls self._adapter().scan() (pyOCD USB enumeration) and logic_backends…scan() (subprocess sigrok-cli --scan, 20 s timeout) — synchronously, on the loop thread. This handler (GET /bench) and the global-dashboard WS handshake both invoke it inline. A probe enumeration (~1 s) or a slow sigrok-cli scan freezes all runs' event streams for that whole window. The subagent's trace confirms none of these calls offload to a thread themselves.
Fix: offload bench_status() through the same executor the pipeline uses, or cache the snapshot and refresh it off-loop.

MEDIUM-3 · Stop can't interrupt an in-flight executor call, and halt() races it on the same probe — angle (c)

stop() correctly emits the terminal pair immediately (event latency is good), then _halt_bench_soon() schedules bench.halt() in another executor thread. But an in-flight flash()/capture() in the executor cannot be cancelled — the physical erase/program/verify (seconds) completes regardless. Worse, halt() (which does session.stop_rtt() + sessions.close()) then runs concurrently with that in-flight flash on the same debug session; the pyOCD RLock serializes individual calls but a close() interleaved into a live flash tears the session down mid-program. So "hardware-safe halt within seconds" (§10.2.3) is only half-true: the run reads stopped fast, the hardware doesn't.
Fix: gate halt() behind the in-flight op (single executor worker per bench, or a re-entrancy guard so halt waits for the current op to yield before touching the session).

MEDIUM-4 · halt() doesn't stop an in-flight capture — angle (b)(c)

halt() only stops RTT and closes the debug session. capture() builds a throwaway logic_backends.build_registry().resolve(...) and calls analyzer.decode(...) (sigrok-cli capture, 60 s timeout) with no handle retained, so a stop mid-capture cannot cancel it — the capture runs to its timeout and its result is discarded only when the coroutine tries to _emit past the sealed log.
Fix: hold the capture handle on the bench and cancel it in halt().

MEDIUM-5 · The flash approval gate is defeatable by board-profile config — angle (b)

flash_approval() returns None when profile.safety.flashRequiresApproval is falsey, and the engine then calls flash() with no approval.requested and no interstitial transition — a hardware-mutating program+reset with zero human gate. There is no floor forcing approval for hardware actions; a mis-authored (or copied) profile silently disables the product's central safety promise. The fake fixture always sets it true, so tests never exercise the None branch.
Fix: treat hardware-mutating steps as approval-required regardless of profile, or make the flag able to raise friction but never remove the gate for flash/reset.

LOW-6 · RECORD mode does blocking file IO on the event loop — angle (d)

dispatch() → FixtureRecorder.on_event() does open(path,"a") + write per event on the loop thread, and export_artifacts() does a bulk read+write at the terminal event. Dev/recording mode and single-run, but it's synchronous IO in the hot emit path.

LOW-7 · runner.status "on device change" is unimplemented — angle (a)

§5.2 says runner.status fires "on connect and on device change." Only the connect snapshot exists (WS handshake); there's no hot-plug/offline monitoring, so a probe or logic analyzer dropping mid-session never reaches the dashboard until a reconnect. Acceptable for MVP but it's a stated-behavior gap.

LOW-8 · build_firmware is an unsandboxed shell=True shell-out from bench config — angle (e)

build() → builder.build_firmware(project_dir, build_command) runs the profile's build_command via subprocess.run(shell=True) in project_dir (subagent-confirmed, builder.py:178). The config is operator-supplied via BOARDEX_BENCH_CONFIG (not HTTP-reachable), so this is RCE-by-design rather than a remote hole — but worth an explicit note that a crafted bench-config file is arbitrary code execution, and project_dir/artifact globs are caller-controlled paths.

LOW-9 · Minor conformance nits — angle (a)(e)

- _global_seq increments per dashboard connection and is otherwise unused; two concurrent dashboards get different snapshot seqs. Harmless (the reducer keys by runId), but the global stream's seq isn't a coherent per-_global sequence.
- The /artifacts/{id} 404 body reflects the raw id (f'artifact "{id}" not found'). JSON content-type and the UI renders it as state, so negligible — noted for completeness.

What is genuinely sound (verified, not assumed): every outbound event is schema-validated in the production append path (EventLog.append → validate_event), not merely in tests; per-run seq is gapless because all _emits run single-threaded on the loop while bench work is in the executor; afterSeq boundaries are correct (0/negative → all, lastSeq → [], beyond → [], non-int → 0); 404/409 semantics and the {error, currentStatus} shape match §5.3; terminal sealing makes post-terminal emits impossible; rejection is terminal-via-stopped (§5.7 rule 3); no retry or timer re-fires a gated action (there are no retries anywhere); stop/reject match the mock reference exactly, including the run.created-before-stop fix; CORS is local-only and the server binds 127.0.0.1 by default; and the pipeline correctly offloads blocking bench calls via _call + executor.

---
Angle (f) — AgentBench reconnaissance (reuse map, not findings)

An agent-session bench slotting behind the same engine/wire layer. The wire vocabulary already generalizes; the scripted pipeline is the coupling.

Bench-agnostic, reuse as-is:

┌────────────────────────────────────────────────────────────┬────────────────────────────┐
│                         Component                          │      Why it transfers      │
├────────────────────────────────────────────────────────────┼────────────────────────────┤
│                                                            │ Pure wire bookkeeping;     │
│ EventLog (seq/emit/validate/seal/after replay)             │ knows nothing about        │
│                                                            │ benches.                   │
├────────────────────────────────────────────────────────────┼────────────────────────────┤
│ ArtifactStore                                              │ By-reference store keyed   │
│                                                            │ on server-generated ids.   │
├────────────────────────────────────────────────────────────┼────────────────────────────┤
│ Approval parking                                           │ Gate is an asyncio.Future; │
│ (_wait_gate/_approval_gate/_release_gate/_cancel_gate)     │  bench-independent.        │
├────────────────────────────────────────────────────────────┼────────────────────────────┤
│ Stop cancellation (stop, _halt_bench_soon, RunTerminated   │ Generic; only needs        │
│ sealing)                                                   │ bench.halt().              │
├────────────────────────────────────────────────────────────┼────────────────────────────┤
│ RECORD tee (FixtureRecorder, dispatch)                     │ Operates on emitted        │
│                                                            │ events.                    │
├────────────────────────────────────────────────────────────┼────────────────────────────┤
│ contract.py validation, clock.py                           │ Fully generic.             │
└────────────────────────────────────────────────────────────┴────────────────────────────┘

FakeBench-coupled, must be replaced:
- _pipeline/_iteration hard-code the stage order (understand_context → edit_code → build → flash_approval → flash → capture → read_serial → evaluate → diagnose) and fixed planIndex 0–5. This is a storyboard, not a step executor.
- The Bench protocol itself is BME280-bringup-shaped (capture, read_serial, evaluate as discrete stages).
- Iteration model (while True fix-approval loop) assumes the diagnose→fix→reflash arc.

Where the spec's tool-call interception middleware attaches: the _call(self.bench.<stage>, …) seam. For an agent, replace the fixed stage sequence with a loop over the agent's emitted tool calls, and generalize _call into "inspect each tool call → if hardware-mutating (flash/reset), park on _approval_gate before executing → then run in executor → emit step.*/artifact.created/check.evaluated." The existing flash_approval() hook (bench decides when a gate is needed) is exactly the seam that becomes "middleware classifies each tool call as gated or not."

Engine assumptions that break under non-deterministic step counts:
- step_id derivation st_{kind}_iter{iteration}_{suffix} assumes one step per kind per iteration — an agent that builds/flashes N times collides ids.
- Fixed planIndex mapping assumes a known plan length; an agent's plan is dynamic and rows may never be claimed or may be exceeded.
- One flash approval per iteration — an agent may perform several hardware mutations per iteration; the engine gates exactly one.
- evaluate / _last_check_total as a terminal discrete stage — an agent evaluates continuously, not at a fixed point.
- iteration as a coarse loop counter feeding run.iteration_started — ill-defined for an open-ended agent; needs a different segmentation signal.

The emit vocabulary is generic enough to express agent activity as-is; the work is replacing _pipeline/_iteration and the Bench protocol with an agent-driven executor while keeping log/store/gates/stop/recorder untouched.

---
Merge report

Verdict: FINDINGS — the contract emit path and wire layer are sound; every material finding lives on the real_bench/hardware seam or event-loop hygiene, none on the schema-validated event stream.

Findings: HIGH — (1) real-bench singleton corrupts concurrent-run state and shares one probe with no run mutex; (2) bench_status() runs USB/sigrok-cli scans on the event loop. MEDIUM — (3) stop can't interrupt an in-flight executor call and halt() races it on the same probe; (4) halt() doesn't cancel an in-flight capture; (5) flash approval gate is defeatable by profile config. LOW — (6) RECORD blocking IO on the loop; (7) runner.status device-change half unimplemented; (8) shell=True build from config; (9) global-seq / 404-reflection nits.

Checks: contract emit exact: y · seq gapless & replay correct: y · 404/409 semantics: y · approvals block per-run: y (but bench not globally quiescent — HIGH-1) · stop honored fast (event) / hardware-safe (halt): y / partial (MED-3/4) · no blocking calls on loop: n (HIGH-2, LOW-6) · tests honest: y (33 passed; but real-bench concurrency & flash-without-approval branches are structurally untestable on the fake bench — noted).

These are backlog items for the backend owner; per §10.4, blocking findings block the demo, not the merge of UI code. HIGH-1, HIGH-2, and MEDIUM-5 are the three I'd rank as demo-blockers if a real bench with more than one run or a dashboard is in the loop.

✻ Cooked for 8m 38s · 2 shells still running

※ recap: Audit of servers/boardex-runner is done: verdict FINDINGS, with two high-severity items (shared real-bench across concurrent runs, hardware scans blocking the event loop) plus the AgentBench reuse map. Next: hand the ranked findings to the backend owner's backlog.

──────────────────────────────────────────────────────────────────────