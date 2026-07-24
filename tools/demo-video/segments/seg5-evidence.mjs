// Segment 5 — EVIDENCE DEEP-DIVE (~60s)
// On the completed run, open the evidence drawer from a band chip and walk every tab:
// Checks (hover a row, follow a sourceDoc citation into Sources with its highlight,
// follow a view-evidence link), Protocol Decode (the NACK rows), Logs (a sub-tab),
// Code Diff (scroll a file), Raw artifacts (hover Download). Then close.

import { getRunId } from '../lib/state.mjs';

export default async function seg5(film) {
  const p = film.page;
  const runId = getRunId();
  if (!runId) throw new Error('seg5: no runId from seg34');
  await film.goto(`/runs/${runId}`);
  await p.getByRole('region', { name: 'Evidence summary' }).waitFor({ timeout: 20000 });
  await film.dwell(1400);

  // Open the drawer from a check chip in the band.
  const band = p.getByRole('region', { name: 'Evidence summary' });
  const chip = band.getByRole('list', { name: 'Evidence checks' }).getByRole('link').first();
  await film.click(chip, { post: 1000 });
  const drawer = p.getByRole('dialog', { name: 'Evidence' });
  await drawer.waitFor({ timeout: 10000 });
  await film.dwell(1200);

  const tab = (name) => drawer.getByRole('tab', { name });

  // --- Checks ---
  await film.click(tab('Checks'), { post: 700 });
  const firstRow = drawer.locator('table tbody tr').first();
  await film.hover(firstRow, 1000);
  await film.dwell(900);

  // Follow a datasheet citation from a check's Source column → Sources tab, which
  // scrolls to and highlights the cited heading.
  const sourceLink = drawer.getByRole('link', { name: /datasheet|§/ }).first();
  if (await sourceLink.isVisible().catch(() => false)) {
    await film.click(sourceLink, { post: 1100 });
    await p.locator('[data-located="true"]').first().waitFor({ timeout: 8000 }).catch(() => {});
    await film.hover(p.locator('[data-located="true"]').first(), 1200);
    await film.dwell(2600); // the citation highlight
    await film.scroll(180, { steps: 8 });
    await film.dwell(1200);
  }

  // Back to Checks, follow a "View evidence" link.
  await film.click(tab('Checks'), { post: 600 });
  const viewEvidence = drawer.getByRole('link', { name: 'View evidence' }).first();
  if (await viewEvidence.isVisible().catch(() => false)) {
    await film.click(viewEvidence, { post: 1100 });
    await film.dwell(1400);
  }

  // --- Protocol Decode: dwell on the NACK rows ---
  await film.click(tab('Protocol Decode'), { post: 800 });
  await film.dwell(1400);
  await film.scroll(300, { steps: 12 });
  await film.dwell(1800); // NACK rows
  await film.scroll(240, { steps: 10 });
  await film.dwell(1400);

  // --- Logs: the two segmented selectors (Iteration × Type) that replaced the old
  // flat sub-tabs (Sprint 7 P0, §7.4). Show both axes: flip the Type, then the
  // Iteration, landing on a populated cell each time. ---
  await film.click(tab('Logs'), { post: 800 });
  await film.dwell(900);
  const typeGroup = drawer.getByRole('group', { name: 'Type' });
  for (const kind of ['Serial', 'Flash', 'Build']) {
    const btn = typeGroup.getByRole('button', { name: kind });
    if ((await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false))) {
      await film.click(btn, { post: 800 });
      await film.dwell(1100);
      break;
    }
  }
  const iter2 = drawer.getByRole('group', { name: 'Iteration' }).getByRole('button', { name: '2' });
  if ((await iter2.isVisible().catch(() => false)) && (await iter2.isEnabled().catch(() => false))) {
    await film.click(iter2, { post: 800 });
    await film.dwell(1300);
  } else {
    await film.dwell(1000);
  }

  // --- Code Diff: scroll one file ---
  await film.click(tab('Code Diff'), { post: 800 });
  await film.dwell(1100);
  await film.scroll(320, { steps: 12 });
  await film.dwell(1500);

  // --- Raw artifacts: hover Download ---
  await film.click(tab('Raw artifacts'), { post: 800 });
  await film.dwell(1000);
  const download = drawer.getByRole('button', { name: 'Download' }).first();
  if (await download.isVisible().catch(() => false)) await film.hover(download, 1600);
  await film.dwell(1000);

  // Close the drawer.
  const close = drawer.getByRole('button', { name: 'Close' }).first();
  await film.click(close, { post: 1000 });
  await film.dwell(900);
}
