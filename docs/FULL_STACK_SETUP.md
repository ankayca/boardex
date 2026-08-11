# Boardex Full-Stack Setup — Runner (BENCH=agent) + UI on One Machine

Audience: the runner maintainer. Scope: everything from clean checkout to a live agent run in the browser, on your machine, hardware optional. Companion doc for the hardware itself: `docs/SUPPORT_MATRIX.md` (OS tiers, probe and analyzer access, per-OS driver permissions). This doc is the plumbing underneath it.

---

## 1. Prerequisites

- Python ≥ 3.10, Node ≥ 20, npm. `arm-none-eabi-gcc` on PATH for build tasks (you have it).
- Repo at current `main` (contains AgentBench, contract v2.2, UI through T6.6).

## 2. Python side — venv + the four packages

```bash
cd <repo>
python3 -m venv .venv && source .venv/bin/activate
pip install -e "servers/boardex-core[dev]"
pip install -e "servers/boardex-target[dev]"
pip install -e "servers/boardex-logic[dev]"
pip install -e "servers/boardex-runner[dev]"      # pulls litellm + mcp (AgentBench deps)
pytest servers/boardex-runner                      # ~81 green, no API key needed
```

## 3. Node side — UI

```bash
npm install
npm run verify        # full JS suite green
```

## 4. LLM API key — one-time (this is new relative to your Cursor run)

Your BMP180 session billed through Cursor's subscription. AgentBench calls the model API directly, so it needs a real key. Two options:

**Option A — OpenRouter (what we've validated):**
1. openrouter.ai → sign in → add credits ($10 covers many runs) → **Keys** → create → copy `sk-or-v1-…` (shown once).
2. `export OPENROUTER_API_KEY=sk-or-v1-…` in the shell that will launch the runner. Model strings use the `openrouter/` prefix: `openrouter/anthropic/claude-sonnet-4.6`.

**Option B — direct Anthropic:** console.anthropic.com → credits → key → `export ANTHROPIC_API_KEY=sk-ant-…`; model string `anthropic/claude-sonnet-4-6` (LiteLLM routes by prefix).

Rules that bit us, so they don't bite you:
- **Env-only, session-scoped.** Never in files, never committed, never in `~/.bashrc` (a stale `ANTHROPIC_API_KEY` there can also break Claude Code's own auth).
- **Never paste the literal placeholder.** `export OPENROUTER_API_KEY=sk-or-v1-...` with the dots exports the *string* `sk-or-v1-...`; the run then fails at 0:00 with "waiting for the plan" and no terminal error (the failure lands in the run's Agent log, not stdout). Verify with `echo ${OPENROUTER_API_KEY:0:12}`.

## 5. The agent's workspace — a writable checkout

The agent **edits real files** via harness-owned file tools. Give it a scratch copy, never your working tree:

```bash
cp -r examples/firmware firmware/agent-workspace
```

## 6. Launch the runner

```bash
# kill strays first — multiple runners on one port silently break RECORD (see §9)
pkill -f boardex-runner; ss -tln | grep 4380   # must print nothing

BENCH=agent \
AGENT_MODELS=openrouter/anthropic/claude-sonnet-4.6 \
PORT=4380 \
RECORD=$PWD/records/run-$(date +%s) \
.venv/bin/boardex-runner
```

- `AGENT_MODELS`: comma-separated LiteLLM strings; this list is what `/health` advertises and what the composer's model picker shows (picker renders only when >1).
- `AGENT_MAX_TURNS` (default 40) if you want a tighter budget.
- Sanity gate, second terminal: `curl localhost:4380/health` → `{"ok":true, "runnerKind":"real", …, "capabilities":{"models":[…]}}`.
- Two-machine setup (UI elsewhere): add `HOST=0.0.0.0` and point the UI at `http://<bench-ip>:4380` — either via env below or Settings → Runner URL (T6.6) at runtime.

## 7. Launch the UI

```bash
VITE_RUNNER_URL=http://localhost:4380 npm run dev -w @boardex/ui
```

Open the printed URL. Bottom-left pill must read **Runner online · real**. (The URL can also be changed live in **Settings** — Test Connection verifies before you commit to it.)

## 8. First run

1. **Boards → New Profile**: `repoPath` = absolute path to the workspace copy (e.g. `<repo>/firmware/agent-workspace/rtt-f303re`), build command `make`, real instrument ids if hardware is attached (else leave empty — the amber "not found on the bench" notice is advisory and never blocks). Save.
2. **New Run** → select that profile → type the task → **Create Run Plan**.
   - Hardware-free smoke task (proven): *"Change the console output format in the reference firmware to print PRESSURE=<p> alongside TEMP/HUM, and build it."*
   - Hardware stages: build-only Stage A first, then the BMP180 prompt; device access per `docs/SUPPORT_MATRIX.md`.
3. Approve the plan in the UI. Flash/reset tool calls will park on approval cards — that's `interception.py`'s floor, regardless of profile config. Reject ends the run as `stopped` with the tool provably never invoked.

## 9. RECORD — the discipline that keeps recordings non-empty

The tee writes `<dir>/recorded_run.jsonl` + `artifacts/`. Two ways to end up with a 0-byte file (we did):
1. **Two runner processes, browser drove the un-RECORDed one.** Hence the `pkill` + `ss` check before launch — exactly one listener on the port, always.
2. **No graceful shutdown.** After the run reaches a terminal state in the UI, **Ctrl-C the runner** before checking the file — the tee may flush on shutdown.

Verify every recording immediately: `wc -l <dir>/recorded_run.jsonl` (>0) and `ls <dir>/artifacts/`. A recording that validates (`npm run test -w packages/contract` fixture suite pattern) is a §10.3 fixture candidate — your Stage B BMP180 recording is the one we want as the flagship demo.

## 10. Troubleshooting index

| Symptom | Cause | Fix |
|---|---|---|
| Run FAILED at 0:00, "waiting for the plan" | Key missing/placeholder/invalid — first model call died | §4; the actual provider error is in the run's **Agent log** in the UI |
| Run FAILED at 0:00, key confirmed good | Profile `repoPath` doesn't exist | §8.1 — absolute path to a real checkout |
| `EADDRINUSE` / `address already in use` on launch | Stray runner from an earlier session | `pkill -f boardex-runner`, re-check `ss` |
| Pill says **mock** not **real** | UI pointed at the wrong port | `VITE_RUNNER_URL`, or Settings → Runner URL → Test Connection |
| Recording empty | §9, either cause | Single listener + graceful Ctrl-C |
| Build step fails, agent diagnoses missing compiler | Toolchain not on the runner shell's PATH | Launch the runner from a shell where `which arm-none-eabi-gcc` resolves |
