# Boardex UI — walkthrough shot list (v2 · round-2 design review)

**File:** `boardex-walkthrough-v2.mp4` · 1920×1080 · 30 fps · **6:59** · light theme
**Recorded:** headless Chromium against the mock runner (BME280 fixture for §1–8, the
real `records/bmp180-run` hardware recording for §9). The blue dot is an injected
cursor — Chromium paints none — so you can follow every interaction. Pace is tuned for
watching, not testing: deliberate dwells, eased pointer travel, small-step scrolls.

**What changed since round 1:** this cut re-films the same arc through the shipped
**Sprint 7 P0+P1 visual system** — the re-pointed three-layer surface palette + accent,
the four-class **badge split**, the **reserved right-rail slot** that swaps content in
place, the **dual-outcome** run summary, the **cited-source** highlight in Sources, the
denser decode tables, and the report's document typography. Every ⭐ note below names a
P0/P1 change to evaluate.

Timestamps are where each segment **starts** in the final file. Segments 3 and 4 are one
continuous take (composer → run → completion), so their internal beats are timestamped
too.

| # | Segment | Starts |
|---|---------|--------|
| 1 | First impression — empty Home | **0:00** |
| 2 | Demo mode — the product explaining itself | **0:11** |
| 3 | Composer → Plan gate | **1:14** |
| 4 | The run as theater | **~1:52** |
| 5 | Evidence deep-dive | **3:40** |
| 6 | The report | **4:38** |
| 7 | Boards + Settings | **4:59** |
| 8 | Keyboard | **5:38** |
| 9 | The real run — BMP180 on real hardware | **5:48** |

---

## 1 · First impression — empty Home · **0:00**
Empty-state hero ("Bring up your first board"), both hero actions hovered (New Run /
Watch a demo run), then the sidebar collapse→expand toggle once.
- **Look at:** empty-state composition and vertical centering — is the hero balanced in a
  1920-wide frame, or stranded? Is the primary/secondary button pairing legible at this
  weight?
- ⭐ **Canvas hierarchy (P0):** the shell now sits on the tinted application canvas
  (`#F7F7F8`) with the sidebar on the navigation surface (`#FBFBFC`) — white work surfaces
  are meant to read *against* a tint, never white-on-white. Does the three-layer depth
  read on the empty screen, or does it feel flat?
- **Look at:** the collapsed sidebar (56px) — do the icon-only affordances still read?

## 2 · Demo mode — the product explaining itself · **0:11**
"Watch a demo run" enters the guided tour (its own read-only DemoShell — note the
"Demo · replaying a recorded agent run" badge + playback controls). The recorded BME280
run plays with callouts 1→6. Playback is **paused** on callout 3 ("The approval gate") to
hold it, then resumes through checks (4), the failure/diagnosis (5), and skip-to-end lands
on the report callout (6).
- **Look at:** the tour callout card — placement, zone label ("STATUS & APPROVAL"), the
  `3 / 6` counter, and how it competes (or doesn't) with the workspace behind it.
- **Look at:** the approval-gate callout copy + card hierarchy while paused (~0:35).

## 3 · Composer → Plan gate · **1:14**
Typing the BME280 task at human speed, profile select, **Create Run Plan**. The plan
gate renders: six numbered steps with risk badges, a **Risk summary**, and the
six-line **"Confirm bench connections"** checklist, checked one by one, then **Approve
Plan** (disabled until all six are ticked).
- **~1:38 — plan gate on screen.**
- ⭐ **Badge split — Risk class (P0):** the risk badges are now their own class —
  five **LOW** as *filled neutral capsules* (dark text, must NOT read disabled) vs the
  single **MEDIUM** (amber) on "Build and flash the firmware", with a separate
  "Hardware action" marker. Amber is reserved for approval/warning only — confirm it
  never reads as decoration, and that LOW never reads as "off".
- ⭐ **Visible plan gate (P0):** the live "**N of 6** bench connections confirmed" line
  and the disabled primary reading **"Approve Plan · 3/6 confirmed"** → plain "Approve
  Plan" at completion. Is the tick-all-six-to-unlock gate legible? The risk summary sits
  on a quiet neutral surface with a narrow **amber left-rail** only because a medium-risk
  action exists — is that restraint right?

## 4 · The run as theater · **~1:52**
The three-zone workspace during a live run: streaming logs, the flash approval, a real
failure, diagnosis, an iteration, and completion.
- ⭐ **Reserved right-rail slot — the no-reflow swap (P0), the headline of this cut.**
  Watch the ONE region directly under the sticky Status card as its content swaps **in
  place, with zero layout jump**:
  - **~1:52 — autonomous state:** "No approval required · Boardex is working / executing
    *[active step]*", live from the run.
  - **~2:08 — approval surface:** the **Flash Approval Card** occupies the *same* slot
    (title / **MEDIUM** risk badge / reason / "1 file changed" / hardware actions /
    **Approve & Continue** primary · Review Diff · Reject). Status badge flips to
    **AWAITING APPROVAL** (amber).
  - **~2:30 — diagnosis surface:** the Diagnosis Card (ranked hypotheses, confidence
    labels) in the same slot while the run reads **DIAGNOSING**.
  - **~3:36 — completion module:** "Run complete" + **Open Validation Report** in the
    same slot.
  **Evaluate:** does the rail geometry hold across all four states? Is "same slot,
  new content" obvious, or does anything twitch?
- **~2:10 — Build log** open with **Timestamps** on and **find-in-log "bme280"** cycling
  matches, then cleared. ⭐ **Log density (P1):** per-stream tabs with the 2px accent
  underline at the seam, the optional per-line timestamp column, monospace at 12.5px —
  log text is never colour-coded (D14). Is the pane dense-but-calm?
- **~2:08 — Flash approval card** — ⭐ **approval-card hierarchy (P0):** is "Approve &
  Continue" unmistakably primary vs Review Diff (secondary, white/strong-border) and
  Reject (tertiary-danger text)? **Review Diff** opens the code-diff drawer, back,
  **Approve & Continue**.
- **~2:25 — the Serial stream**, then **Validate measurements → Failed**.
- **~2:30 — Diagnosis card**: ranked hypotheses (High / Low / Low), proposed fix
  (**MEDIUM**), **Approve Fix Plan**; evidence band shows **I2C clock · Device ack ·
  Serial output** with verdict badges.
- **~3:10 — Iteration 2** divider ("Iteration 2 — applying fix"); the band chips flip
  **FAIL → PASS**.
- **~3:36 — COMPLETED**, frozen **Elapsed 10:51**, **VERIFIED 6 / 6**, the dual-outcome
  split ("Run execution — Completed · … / Validation coverage — 3 of 3 checks recorded"),
  **Open Validation Report**.
- ⭐ **Badge split — Verdict vs Inline-step (P0):** the evidence-band chips carry
  **icon-led verdict badges** (icon + "Pass"/"Fail", colour is never the only signal),
  while the timeline steps use **neutral inline-step** text (the green lives in the check
  *icon*, not the word — a column of successes should read calm, not lit up). Confirm the
  color-noise budget holds. **Look at:** the FAIL→PASS flip at ~3:10 — readable or too
  subtle?

## 5 · Evidence deep-dive · **3:40**
From a band chip, the evidence drawer opens; every tab is walked: **Checks** (a row
hovered, a datasheet **citation followed into Sources** where the cited heading
highlights, a **View evidence** link), **Protocol Decode**, **Logs** (the new
Iteration × Type selectors), **Code Diff** (scroll), **Raw artifacts** (Download hovered).
- ⭐ **Cited-source arrival (P1) — ~3:55:** following a check's `§` source link lands in
  the **Sources** tab (new since round 1, tab position 2) and scrolls to the cited
  heading, which gets the **"CITED SOURCE" label + accent left-rail + accent-tint** wash
  (`#ECEBFB` — a light tint of the accent, deliberately NOT a D14 semantic). **Evaluate:**
  is "this heading is the cited source" obvious, or too quiet?
- ⭐ **Decode density (P1) — ~4:10:** the Protocol Decode table
  (Time / Addr / R-W / Ack / Data / Annotation), monospace + tabular numerals, failed
  transactions tinted with the fail bg-tint only. Is the density right for scanning
  ACK vs "NACK (final byte)" rows?
- ⭐ **Logs sub-nav (P0):** the old flat sub-tabs were replaced by two compact segmented
  selectors — **Iteration [1|2] × Type [Build|Flash|Serial]** — that can never wrap.
  Watch a Type flip and an Iteration flip.
- **Look at:** the 760px drawer over the dimmed run (scrim `rgba(23,23,26,0.35)`) —
  tab-bar legibility and the Checks-table density (Requirement / Expected / Actual /
  Verdict / Source / Evidence).

## 6 · The report · **4:38**
The rendered Validation Report: the **dual-outcome header** ("Run execution — Completed /
Validation coverage — 3 of 3 checks recorded"), a full slow scroll (Objective, Board &
firmware context, Procedure, evidence deep links), two deep links hovered, **Copy
Markdown → "Copied ✓"**.
- ⭐ **Report as document (P1):** long-form typographic rhythm — the 22px report title,
  15px section headings, body/`code` treatment, and how inline evidence deep links
  (underlined) sit in body prose without shouting. Does it read as a document a firmware
  engineer would attach to a PR?
- **Look at:** the Copy affordance and its **"Copied ✓"** confirmation state (~4:56).

## 7 · Boards + Settings · **4:59**
Board Profiles → **Edit** the Nucleo-F303RE profile → scroll the form sections →
**Validate Profile** (green "found" panel). Then Settings: the Runner URL field, **Test
connection** ("Online · mock"), the model list, and **Replay onboarding** (hovered).
- **~5:15 — the green validated panel** with per-instrument found dots.
- **Look at:** form-section rhythm and field grouping over a long scroll; the green
  success panel — green (`#168A4A`) must read strictly as pass/found here.
- **Look at:** Settings status line states ("Online · mock") and the StatusDot — every
  failed probe verdict is amber, never red.

## 8 · Keyboard · **5:38**
⌘K command palette: empty-state defaults, typing **"boa"** with **fuzzy match
highlighting** on "**Boa**rds", Enter navigates; then **?** opens the shortcuts overlay.
- **Look at:** the palette's fuzzy-highlight treatment (accent on matched chars) and
  result grouping (NAVIGATION header); the overlay elevation over the scrim.
- **Look at:** the shortcuts overlay `<kbd>` styling and the Global / In-the-palette
  grouping.

## 9 · The real run — BMP180 on real hardware · **5:48**
The mock is repointed at `records/bmp180-run`, the first real-hardware agent run
(model `openrouter/anthropic/claude-sonnet-4.6`). The gates are auto-resolved so the
replay reaches its **honest terminal state: `run.failed` at the 40-turn budget**. Shown:
the **FAILED** badge, the real agent's ~40-step trail (a real `chip_id=0x55` RTT wait that
fails then retries), the **Kingst LA2016 protocol decode** (real capture, NACK rows), and
the report's verdict.
- ⭐ **Dual-outcome summary (P0) — the centerpiece the designer asked for, ~6:24:** the
  Status card separates two dimensions under the FAILED badge —
  **"Run execution — Failed · Run terminated by harness: turn bound exceeded:
  max_turns=40 (partial report attached)"** over the honest
  **"Validation coverage — 2 checks recorded · no check registry declared"**. This is a
  pre-v2.4 recording that declared no check registry, so coverage carries **no invented
  denominator** — it is never parsed from prose or report markdown. **Evaluate:** a
  budget-killed run whose firmware worked must NOT read as a hardware failure — does the
  split land that, honestly and without alarm? (The same split heads the report at ~6:45.)
- **~6:35 — the decode:** real Kingst LA2016 I2C capture — density with real capture data.
- **~6:50 — the report:** the Run Outcome table (5 checks PASS, `i2c_clock_freq` **NOT
  RECORDED — turn budget exhausted**) and **"Overall: FAILED — … All sensor-functional
  checks passed; the firmware is working correctly."**
- **Look at:** the FAILED badge (red `#C73535`) legibility and tone; the "NOT RECORDED"
  verdict styling — neutral, never red (absence of evidence is not failure).

---

### Notes for review
- **Color semantics are reserved** (Boardex rule, D14): green = pass, red = fail, amber =
  approval/warning, one accent (`#5B4CF0`) for actions. The accent bg-tint (`#ECEBFB`,
  the §5 citation wash) is a light accent tint, NOT a semantic. Flag anything that uses a
  reserved color decoratively.
- No dark mode, gradients, or glassmorphism in MVP — light theme only, by design.
- **One rendering nit carried from round 1** (app content, not a capture artifact, and out
  of scope for this re-film): in §9's Run Outcome table (~6:52) the PASS check-glyph
  renders as tofu (▯) because the report markdown uses a color-emoji checkmark (✅) absent
  from the mono font stack. Worth a font/emoji-fallback pass on the report renderer — the
  report markdown is the agent's, so the fix belongs in the renderer, not the fixture.
- **All nine segments recorded with zero console errors**; the shipped Sprint 7 P0+P1 UI
  is the source of truth (the shoot scripts were adjusted to it, never the reverse).
- **Total 6:59** — inside the 7:00 target. The one unavoidable long take is §3–4's
  run-to-completion (the 6/6 COMPLETED reveal lands at the end of that continuous take).
