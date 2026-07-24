// Segment 1 — FIRST IMPRESSION (~20s)
// Home empty state: the hero, both hero actions hovered, and the sidebar collapse
// /expand toggle shown once. Runs first, against a fresh mock (zero runs) so the
// empty state renders.

export default async function seg1(film) {
  await film.goto('/');
  const main = film.page.getByRole('main');
  // Wait for the empty-state hero to render (GET /runs → []).
  await film.page.getByText('Bring up your first board').waitFor({ timeout: 15000 });
  await film.dwell(1800); // hold on the hero composition

  // Hover the two hero actions, deliberately.
  const newRun = main.getByRole('button', { name: 'New Run' }).first();
  await film.hover(newRun, 1100);
  const watchDemo = main.getByRole('button', { name: 'Watch a demo run' });
  await film.hover(watchDemo, 1300);

  // Sidebar collapse → hold → expand, shown once.
  const collapse = film.page.getByRole('button', { name: 'Collapse sidebar' });
  await film.click(collapse, { post: 1500 });
  const expand = film.page.getByRole('button', { name: 'Expand sidebar' });
  await film.click(expand, { post: 1200 });

  // Settle back on the hero.
  await film.moveTo(960, 420);
  await film.dwell(1400);
}
