// Segments 3 + 4 — COMPOSER → PLAN GATE → THE RUN AS THEATER (~135s, one take)
// Drives a real run against the mock runner: compose the BME280 task, walk the plan
// gate checklist, approve, then film the workspace as the run streams, gates on the
// flash approval, fails a check, diagnoses, applies a fix, and completes 6/6.
//
// Exposes the created runId on film.context so segments 5/6 can inspect the same run.
// The mock PAUSES at each gate (plan, flash approval, fix approval) until the UI
// resolves it, so the log-viewer deep-dive happens against settled content — no race.

import { setRunId } from '../lib/state.mjs';

const BME280_TASK =
  'Bring up the BME280 sensor over I2C on this STM32 board. Verify timing and ' +
  'confirm valid temperature/humidity readings over serial.';

export default async function seg34(film) {
  const p = film.page;

  // ---- Segment 3: Composer ----------------------------------------------------
  await film.goto('/runs/new');
  const task = p.getByRole('textbox', { name: 'Ask Boardex' });
  await task.waitFor({ timeout: 15000 });
  await film.dwell(900);
  await film.type(task, BME280_TASK, { delay: 34 }); // human typing
  await film.dwell(900);

  // Select the board profile (single option, but show the interaction).
  const profile = p.getByLabel('Board profile');
  await film.moveToEl(profile);
  await profile.selectOption({ label: 'Nucleo-F303RE' }).catch(() => {});
  await film.dwell(900);

  const create = p.getByRole('button', { name: 'Create Run Plan' });
  await film.click(create, { post: 1400 });

  // ---- Segment 3: Plan gate ---------------------------------------------------
  const plan = p.getByRole('region', { name: 'Run plan' });
  await plan.waitFor({ timeout: 20000 });
  const runId = p.url().split('/runs/')[1]?.split(/[/?]/)[0];
  setRunId(runId);
  await film.dwell(1200);

  // Slow scroll through the six steps and the risk summary.
  await film.scroll(320, { steps: 12 });
  await film.dwell(700);
  await film.scroll(320, { steps: 12 });
  await p.getByText('Risk summary', { exact: false }).scrollIntoViewIfNeeded().catch(() => {});
  await film.dwell(1400);

  // Check the six bench-connection lines one by one, deliberately.
  const boxes = p.getByRole('checkbox');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    const b = boxes.nth(i);
    await film.moveToEl(b);
    await b.check({ timeout: 5000 }).catch(() => {});
    await film.dwell(520);
  }
  await film.dwell(700);
  const approvePlan = p.getByRole('button', { name: 'Approve Plan' });
  await film.click(approvePlan, { post: 1600 });

  // ---- Segment 4: The run as theater ------------------------------------------
  // The workspace renders once the run leaves plan_ready. Watch the active step
  // stream for a beat.
  await p.getByRole('region', { name: 'Plan and progress' }).waitFor({ timeout: 20000 });

  // seg4 review highlight — THE RESERVED RAIL SLOT (Sprint 7 P0, §7.3). One stable
  // region under the sticky status card whose content swaps in place with ZERO
  // layout jump. Beat 1 of 3: the QUIET AUTONOMOUS state ("No approval required ·
  // Boardex is executing …"). Anchor the camera on the slot so the later swaps land
  // in the same spot — the no-reflow behavior is the thing to evaluate.
  const railSlot = p.locator('[data-testid="rail-action-slot"]');
  await railSlot.waitFor({ timeout: 20000 }).catch(() => {});
  await film.moveToEl(railSlot).catch(() => {});
  await film.dwell(4200); // hold on "No approval required · Boardex is executing …"

  // Flash approval gate: the mock pauses here. Do the log-viewer deep-dive on the
  // now-complete Build step while we wait, then handle the approval.
  const approval = p.getByRole('region', { name: 'Approval required' });
  await approval.waitFor({ timeout: 90000 });
  await film.dwell(800); // let streaming settle before touching the log pane

  // seg4 rail-slot beat 2 of 3: the SAME slot now holds the Approval Card — the
  // autonomous line was replaced in place, the rail geometry did not reflow.
  await film.moveToEl(railSlot).catch(() => {});
  await film.dwell(2000); // hold on the swap: autonomous → approval, same slot

  // Expand the Build firmware step and explore its log stream.
  const buildStep = p.getByRole('button', { name: /Build firmware/ }).first();
  if (await buildStep.isVisible().catch(() => false)) {
    await film.click(buildStep, { post: 700 });
  }
  // Stream tab: Build (its native, populated stream).
  const buildTab = p.getByRole('tab', { name: /^Build/ }).first();
  if (await buildTab.isVisible().catch(() => false)) {
    await film.click(buildTab, { post: 800 });
  }
  await film.dwell(1200);

  // Timestamps toggle (only present when the stream carries per-line timestamps).
  const ts = p.getByRole('button', { name: 'Timestamps' }).first();
  if (await ts.isVisible().catch(() => false)) {
    await film.click(ts, { post: 900 });
    await film.dwell(700);
  }

  // Find-in-log: type "bme280" (matches on the build log), cycle, then clear.
  const find = p.getByRole('textbox', { name: /Find in/ }).first();
  if (await find.isVisible().catch(() => false)) {
    await film.type(find, 'bme280', { delay: 90 });
    await film.dwell(1100);
    for (let i = 0; i < 3; i++) { await find.press('Enter'); await film.dwell(750); }
    await find.press('Escape');
    await film.dwell(700);
  }

  // The flash approval itself: read the card, open the diff, come back, approve.
  await film.moveToEl(approval);
  await film.dwell(1200);
  const reviewDiff = approval.getByRole('link', { name: 'Review Diff' });
  if (await reviewDiff.isVisible().catch(() => false)) {
    await film.click(reviewDiff, { post: 1200 });
    await p.getByRole('dialog', { name: 'Evidence' }).waitFor({ timeout: 8000 }).catch(() => {});
    await film.dwell(1600);
    await film.scroll(260, { steps: 10 });
    await film.dwell(1400);
    const close = p.getByRole('button', { name: 'Close' }).first();
    if (await close.isVisible().catch(() => false)) await film.click(close, { post: 900 });
  }
  const approveContinue = approval.getByRole('button', { name: 'Approve & Continue' });
  await film.click(approveContinue, { post: 1400 });

  // Streaming resumes: Flash → Capture → Read serial. Collapse the Build step first so
  // its (empty) Serial tab can't shadow the serial step's populated one, then show the
  // serial stream and let the failure land.
  if (await buildStep.isVisible().catch(() => false)) {
    await film.click(buildStep, { post: 400 }); // collapse Build step
  }
  const serialStep = p.getByRole('button', { name: /^Read serial output/ }).first();
  await serialStep.waitFor({ timeout: 60000 }).catch(() => {});
  if (await serialStep.isVisible().catch(() => false)) {
    await film.click(serialStep, { post: 700 });
    const serialTab = p.getByRole('tab', { name: /^Serial/ }).first();
    if (await serialTab.isVisible().catch(() => false)) await film.click(serialTab, { post: 900 });
    await film.dwell(2400);
  }

  // Fix approval gate: the diagnosis card with ranked hypotheses + failing evidence.
  const fixBtn = p.getByRole('button', { name: 'Approve Fix Plan' });
  await fixBtn.waitFor({ timeout: 90000 });
  const diagnosis = p.getByRole('region', { name: 'Diagnosis' });
  await diagnosis.scrollIntoViewIfNeeded().catch(() => {});
  await film.dwell(1500);
  // Dwell on the evidence band's FAIL chips.
  const band = p.getByRole('region', { name: 'Evidence summary' });
  await film.hover(band, 1200);
  await film.dwell(1400);
  await film.hover(diagnosis, 1000);
  await film.dwell(2400); // ranked hypotheses
  await film.click(fixBtn, { post: 1600 });

  // Iteration 2: the divider arrives, verdict chips flip FAIL → PASS, run completes.
  await p.getByRole('listitem', { name: /Iteration 2/ }).waitFor({ timeout: 60000 }).catch(() => {});
  await film.dwell(2200);
  // Watch the band flip and the run finish.
  await p.getByText('Completed', { exact: false }).first().waitFor({ timeout: 90000 }).catch(() => {});
  await film.hover(band, 1400);
  await film.dwell(1600);

  // Land on the frozen result: the status card's dual outcome + the report CTA.
  const status = p.getByRole('region', { name: 'Run status' });
  await status.scrollIntoViewIfNeeded().catch(() => {});
  await film.moveToEl(status);
  await film.dwell(1800);

  // seg4 rail-slot beat 3 of 3: on the terminal state the SAME slot holds the
  // Completion Module ("Run complete" + Open Validation Report) — the third and
  // final swap in place. Anchor on the slot, then the CTA.
  await film.moveToEl(railSlot).catch(() => {});
  await film.dwell(1800); // hold on the completion module in the reserved slot
  const reportCta = p.getByRole('link', { name: 'Open Validation Report' });
  if (await reportCta.isVisible().catch(() => false)) await film.hover(reportCta, 1600);
  await film.dwell(1600);
}
