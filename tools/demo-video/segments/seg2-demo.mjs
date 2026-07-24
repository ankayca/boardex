// Segment 2 — DEMO MODE (~60s)
// Enter the guided demo from Home and let the tour narrate itself. The demo replays
// the recorded run and auto-resolves its approvals, so the "approval gate" is the
// tour CALLOUT (step 3/6), not a blocking card. Hold on it by pausing the demo's own
// playback while the callout shows, then resume for the checks/diagnosis/report beats.

const holdForCallout = async (film, title, ms, timeout = 30000) => {
  await film.page.getByText(title, { exact: true }).waitFor({ timeout }).catch(() => {});
  await film.dwell(ms);
};

export default async function seg2(film) {
  const p = film.page;
  await film.goto('/');
  await p.getByText('Bring up your first board').waitFor({ timeout: 15000 });
  const watch = p.getByRole('main').getByRole('button', { name: 'Watch a demo run' });
  await film.click(watch, { post: 1200 });

  const tour = p.getByRole('region', { name: 'Demo tour' });
  await tour.waitFor({ timeout: 15000 });
  await holdForCallout(film, 'The plan', 3200, 10000); // step 1

  // Step 2 — "Watch it work": advance and watch a step's log stream.
  const next = tour.getByRole('button', { name: 'Next' });
  await film.click(next, { post: 700 });
  await holdForCallout(film, 'Watch it work', 4200, 8000);

  // Step 3 — "The approval gate": wait for the run to reach the approval moment (the
  // tour auto-advances to it), PAUSE so the callout holds, and dwell on it fully.
  await p.getByText('The approval gate', { exact: true }).waitFor({ timeout: 30000 });
  const pause = p.getByRole('button', { name: 'Pause' });
  if (await pause.isVisible().catch(() => false)) await film.click(pause, { post: 500 });
  await film.hover(tour, 800);
  await film.dwell(5200); // the safety-guarantee callout, held
  const resume = p.getByRole('button', { name: 'Resume' });
  if (await resume.isVisible().catch(() => false)) await film.click(resume, { post: 600 });

  // Step 4 — checks light up in the evidence band.
  await holdForCallout(film, 'Every claim links to proof', 4500, 25000);

  // Step 5 — a check fails, diagnosis appears.
  await holdForCallout(film, 'When a check fails', 4200, 20000);

  // Step 6 — the deliverable. Jump the tail of the replay to the completed report.
  const skip = p.getByRole('button', { name: 'Skip to end' });
  if (await skip.isVisible().catch(() => false)) await film.click(skip, { post: 1200 });
  await holdForCallout(film, 'The deliverable', 4200, 8000);
}
