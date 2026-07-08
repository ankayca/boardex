---
name: verify
description: Drive the Boardex UI against the mock runner in a headless browser to verify a change end-to-end.
---

# Verifying Boardex UI changes end-to-end

## Launch

Ports 4319 (mock runner default), 4321, 5173, 5199 are often occupied by leftover
dev processes — pick fresh ports and check with `ss -tln` first. Never
`pkill -f "tsx src/index.ts"` to clean up: the pattern matches every mock runner
on the machine, including ones you don't own. Kill by PID.

```bash
# mock runner (SPEED scales fixture delays; acceptance runs use SPEED=5)
cd tools/mock-runner && SPEED=5 PORT=4333 npx tsx src/index.ts
# UI, pointed at it
cd apps/ui && VITE_RUNNER_URL=http://localhost:4333 npx vite --port 5333 --strictPort
# health checks
curl -s http://localhost:4333/health   # {"ok":true,...,"runnerKind":"mock"}
```

## Drive

No browser tooling in the repo. Install Playwright in the session scratchpad
(NOT the repo): `npm init -y && npm install playwright && npx playwright install
chromium` (skip `--with-deps`; sudo is unavailable and the WSL box already has
the libs). Viewport ≥1280px wide for the three-zone workspace grid; 1100px to
check the right rail stacking under center.

Useful handles (accessible roles, stable):
- Composer: textbox "Ask Boardex", button "Create Run Plan", checkboxes (D12
  checklist), button "Approve Plan". The run id is the last URL segment after
  navigation.
- Workspace: list "Run timeline", status badge `header span[data-kind="status"]`,
  complementary "Board context", step rows are `<li>` with an expand button named
  by step title, log tabs role=tab (Agent/Build/Flash/Serial/RTT), panes
  role=log named "<step> — <Stream> log", lines under `[data-index]` (virtualized
  — only ~30 rows render; short logs render fully).
- Approvals beyond the plan gate have UI from T2.2; until then resolve over HTTP:
  `GET /runs/{id}/events?afterSeq=0`, find unresolved `approval.requested`, then
  `POST /runs/{id}/approvals/{aid} {"status":"approved"}`.

The full fixture at SPEED=5 completes in ~80s with prompt approvals. Collect
`page.on('console')` errors — the §7.2/§7.3 done-criteria include "no console
errors". Mid-run reload is the standard replay check: completed steps' log
content must be byte-identical before/after.
