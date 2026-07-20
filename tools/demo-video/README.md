# tools/demo-video — Boardex walkthrough shoot

Playwright scripts that drive the real UI against the mock runner and record a
human-paced walkthrough film (see the rendered `demo-video/SHOTLIST.md`). Not part of
the shipped product; not an npm workspace (no `package.json`, so `npm run verify`
ignores it, and `tools/demo-video/**` is eslint-ignored).

## Layout
- `lib/cinema.mjs` — the shoot kit: fake cursor injection, eased pointer travel, small-
  step scrolls, per-segment recording (`shoot`).
- `lib/state.mjs` — cross-segment scratch (the run id seg34 creates, read by seg5/6).
- `segments/segN-*.mjs` — one driver per shot-list segment (seg34 = composer→run→done).
- `record.mjs` — runs segments in order, names each capture `<key>.webm` in `$OUT`.
- `stitch.mjs` — normalizes each `.webm` to uniform 1080p30 H.264 (trimming the blank
  context lead-in), concats to one mp4, and prints the segment timeline.

## Prerequisites
Playwright + Chromium, installed in the **session scratchpad** (never vendored here):

```bash
cd "$SCRATCH" && npm init -y && npm install playwright && npx playwright install chromium
```

Run everything with `NODE_PATH` pointing at that install and `OUT` at a scratch dir.

## Shoot (the order matters — see notes)
```bash
UI=5356 MOCK=4356
# 1) start UI + a fresh mock (default BME280 fixture), light theme
cd apps/ui && VITE_RUNNER_URL=http://localhost:$MOCK npx vite --port $UI --strictPort &
SPEED=4 PORT=$MOCK npx tsx tools/mock-runner/src/index.ts &

cd tools/demo-video
export NODE_PATH="$SCRATCH/node_modules" OUT="$SCRATCH/out" UI_URL="http://localhost:$UI" RUNNER_URL="http://localhost:$MOCK"

# 2) seg34 must run before seg5/6 (it creates the run they inspect).
node record.mjs seg34 seg5 seg6 seg7 seg8
# 3) seg1/seg2 need an EMPTY Home → restart the mock fresh, then record them.
#    (restart mock on $MOCK, runs=[]), then:
node record.mjs seg1 seg2
# 4) seg9 = the real run → restart the mock against the BMP180 recording, high SPEED:
#    SPEED=20 FIXTURE_FILE=records/bmp180-run/recorded_run.jsonl PORT=$MOCK npx tsx tools/mock-runner/src/index.ts
node record.mjs seg9

# 5) stitch → demo-video/boardex-walkthrough.mp4 (+ prints the timeline)
node stitch.mjs
```

Each segment records with `page.on('console')` error capture; `record.mjs` prints any
console errors per segment (the shipped film recorded zero).
