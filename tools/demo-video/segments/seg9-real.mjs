// Segment 9 — THE REAL RUN (~50s)
// The mock is restarted against records/bmp180-run (the first real-hardware agent run)
// at high SPEED. We create the run, auto-resolve its plan + five approval gates over
// HTTP so the replay races to its honest end (run.failed at the turn budget), then
// film the trust story: the FAILED badge, the real agent's step trail, the logic
// analyzer's protocol decode, and the report's "Overall: FAILED" verdict.
//
// This is the last segment — restarting the mock wipes the run segments 5/6 used.

import { RUNNER_URL } from '../lib/cinema.mjs';

const DECODE_ARTIFACT = 'art_fc45ba_009_protocol_decode'; // the capture with real txns

// Fire-and-forget gate driver: keep POSTing every candidate resolution until the run
// reports failed. The mock only accepts the resolution matching its current gate and
// 409s the rest, so blanket-posting each tick is safe and races the run to the end.
async function autoResolve(runId, stop) {
  const base = `${RUNNER_URL}/runs/${runId}`;
  while (!stop.done) {
    try {
      const evs = await (await fetch(`${base}/events?afterSeq=0`)).json();
      const list = Array.isArray(evs) ? evs : evs.events || [];
      if (list.some((e) => (e.event || e).type === 'run.failed')) break;
      // Plan gate.
      await fetch(`${base}/plan/approve`, { method: 'POST' }).catch(() => {});
      // Every requested approval id → approve.
      const ids = new Set();
      for (const raw of list) {
        const e = raw.event || raw;
        if (e.type === 'approval.requested') {
          ids.add(e.payload?.approval?.id || e.payload?.approvalId);
        }
      }
      for (const id of ids) {
        if (!id) continue;
        await fetch(`${base}/approvals/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'approved' }),
        }).catch(() => {});
      }
    } catch {
      /* transient — retry next tick */
    }
    await new Promise((r) => setTimeout(r, 350));
  }
}

export default async function seg9(film) {
  const p = film.page;

  // Create the run through the composer (a valid POST /runs); the replay's own
  // identity (BMP180 title) overrides whatever we type.
  await film.goto('/runs/new');
  const task = p.getByRole('textbox', { name: 'Ask Boardex' });
  await task.waitFor({ timeout: 15000 });
  await film.type(task, 'Bring up the BMP180 pressure/temperature sensor over I2C.', { delay: 22 });
  await film.dwell(500);
  await film.click(p.getByRole('button', { name: 'Create Run Plan' }), { post: 1200 });
  await p.waitForURL(/\/runs\/[^/]+$/, { timeout: 15000 });
  const runId = p.url().split('/runs/')[1].split(/[/?]/)[0];

  // Drive the gates in the background; the auto-resolver returns only once it sees
  // run.failed in the event stream — the honest terminal state. Don't detect failure
  // from the DOM: the plan text literally contains "if a check failed", which a loose
  // text match would trip on immediately.
  const stop = { done: false };
  const driver = autoResolve(runId, stop);
  const cap = new Promise((r) => setTimeout(r, 90000));
  await Promise.race([driver, cap]);
  stop.done = true;
  await driver.catch(() => {});
  await film.dwell(2600); // let the workspace settle on the failed state

  // seg9 CENTERPIECE (Sprint 7 P0 v2.4) — the DUAL-OUTCOME summary in the status
  // card. A budget-killed run whose firmware worked must not read as a hardware
  // failure: the FAILED badge sits above two honest lines —
  //   "Run execution — Failed · Run terminated by harness: turn bound exceeded…"
  //   "Validation coverage — 2 checks recorded · no check registry declared"
  // The coverage carries NO invented denominator (this pre-v2.4 recording declared
  // no registry). Hold on it deliberately.
  const status = p.getByRole('region', { name: 'Run status' });
  await status.scrollIntoViewIfNeeded().catch(() => {});
  await status
    .getByText('Validation coverage')
    .waitFor({ timeout: 8000 })
    .catch(() => {});
  if (await status.isVisible().catch(() => false)) {
    await film.moveToEl(status);
    await film.dwell(4200); // hold on Run execution — Failed / Validation coverage
  }

  // The real agent's step trail — 40 steps of an actual bring-up. Slow scroll.
  const timeline = p.getByRole('region', { name: 'Plan and progress' });
  if (await timeline.isVisible().catch(() => false)) {
    await film.moveToEl(timeline);
    await film.scroll(360, { steps: 14 });
    await film.dwell(1400);
    await film.scroll(360, { steps: 14 });
    await film.dwell(1600);
  }

  // The logic analyzer's real protocol decode — a Kingst LA2016 I2C capture.
  await film.goto(`/runs/${runId}/evidence?artifact=${DECODE_ARTIFACT}`);
  const drawer = p.getByRole('dialog', { name: 'Evidence' });
  await drawer.waitFor({ timeout: 10000 }).catch(() => {});
  await film.dwell(1400);
  const table = drawer.getByRole('table', { name: 'Decoded transactions' });
  if (await table.isVisible().catch(() => false)) await film.hover(table, 1400);
  await film.dwell(2400); // the decoded I2C transactions from the real capture
  const close = drawer.getByRole('button', { name: 'Close' }).first();
  if (await close.isVisible().catch(() => false)) await film.click(close, { post: 800 });

  // The report — its honest "Overall: FAILED — all sensor-functional checks passed".
  await film.goto(`/runs/${runId}/report`);
  await p.getByRole('heading', { name: 'Validation Report' }).waitFor({ timeout: 15000 }).catch(() => {});
  await film.dwell(1400);
  for (let i = 0; i < 6; i++) {
    await film.scroll(300, { steps: 12 });
    await film.dwell(700);
  }
  const overall = p.getByText('Overall: FAILED', { exact: false }).first();
  if (await overall.isVisible().catch(() => false)) {
    await overall.scrollIntoViewIfNeeded().catch(() => {});
    await film.moveToEl(overall);
  }
  await film.dwell(3200); // end the film on the trust story
}
