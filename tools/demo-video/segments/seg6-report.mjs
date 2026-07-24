// Segment 6 — THE REPORT (~30s)
// The rendered validation report for the completed run: a slow full scroll, a couple
// of evidence deep links hovered, and Copy Markdown with its confirmation.

import { getRunId } from '../lib/state.mjs';

export default async function seg6(film) {
  const p = film.page;
  const runId = getRunId();
  if (!runId) throw new Error('seg6: no runId from seg34');
  await film.goto(`/runs/${runId}/report`);
  await p.getByRole('heading', { name: 'Validation Report' }).waitFor({ timeout: 20000 });
  await film.dwell(1600);

  // Slow full scroll through the rendered markdown.
  const article = p.getByRole('article');
  for (let i = 0; i < 5; i++) {
    await film.scroll(300, { steps: 12 });
    await film.dwell(650);
  }
  // Hover a couple of evidence deep links inside the report.
  const links = article.getByRole('link');
  const lc = await links.count();
  for (let i = 0; i < Math.min(lc, 2); i++) {
    await film.hover(links.nth(i), 1100);
  }
  await film.dwell(700);

  // Back to the top, Copy Markdown → confirmation.
  await film.scroll(-1600, { steps: 14 });
  await film.dwell(800);
  const copy = p.getByRole('button', { name: 'Copy Markdown' });
  await film.click(copy, { post: 700 });
  await p.getByText('Copied ✓').waitFor({ timeout: 6000 }).catch(() => {});
  await film.dwell(2400); // hold on the "Copied ✓" confirmation
}
