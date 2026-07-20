// Segment 7 — BOARDS + SETTINGS (~40s)
// Boards list → edit the profile → scroll the form sections → Validate Profile (green
// found states) → back. Then Settings: the runner URL field, Test Connection (online),
// the model section, and the Replay onboarding button (hovered, not clicked).

export default async function seg7(film) {
  const p = film.page;

  // --- Boards ---
  await film.goto('/boards');
  await p.getByRole('list', { name: 'Board profiles' }).waitFor({ timeout: 20000 });
  await film.dwell(1500);
  const edit = p.getByRole('link', { name: 'Edit' }).first();
  await film.click(edit, { post: 1200 });

  // Scroll the form sections.
  await p.getByRole('heading', { name: 'Firmware' }).waitFor({ timeout: 15000 }).catch(() => {});
  await film.dwell(1000);
  await film.scroll(320, { steps: 12 });
  await film.dwell(800);
  await film.scroll(320, { steps: 12 });
  await film.dwell(800);

  // Validate Profile → green "found" states.
  const validate = p.getByRole('button', { name: 'Validate Profile' });
  await validate.scrollIntoViewIfNeeded().catch(() => {});
  await film.click(validate, { post: 900 });
  await p.getByRole('region', { name: 'Bench validation' }).waitFor({ timeout: 10000 }).catch(() => {});
  await film.dwell(3000); // hold on the green validated panel
  const back = p.getByRole('link', { name: /Board Profiles/ });
  if (await back.isVisible().catch(() => false)) await film.click(back, { post: 1000 });

  // --- Settings ---
  await film.goto('/settings');
  await p.getByRole('heading', { name: 'Runner connection' }).waitFor({ timeout: 15000 });
  await film.dwell(1200);
  const url = p.getByLabel('Runner URL');
  await film.hover(url, 900);
  const testConn = p.getByRole('button', { name: 'Test connection' });
  await film.click(testConn, { post: 800 });
  await p.getByText(/Online ·/).waitFor({ timeout: 10000 }).catch(() => {});
  await film.dwell(2200); // the online result

  // Model section + Replay onboarding (hover only).
  await film.scroll(320, { steps: 12 });
  await film.dwell(1000);
  const replay = p.getByRole('button', { name: 'Replay onboarding' });
  if (await replay.isVisible().catch(() => false)) await film.hover(replay, 1800);
  await film.dwell(900);
}
