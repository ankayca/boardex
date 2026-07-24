// Segment 8 — KEYBOARD (~20s)
// ⌘K command palette: the empty state, "boa" with fuzzy highlighting, Enter to
// navigate; then "?" for the shortcuts overlay.

export default async function seg8(film) {
  const p = film.page;
  await film.goto('/');
  await p.getByRole('main').waitFor({ timeout: 15000 });
  await film.dwell(1200);

  // Open the palette.
  await p.keyboard.press('Control+k');
  const palette = p.getByRole('dialog', { name: 'Command palette' });
  await palette.waitFor({ timeout: 8000 });
  await film.dwell(1600); // empty state (navigation defaults listed)

  // Fuzzy search: "boa" → Boards, with match highlighting.
  const input = palette.getByRole('combobox', { name: 'Search commands, runs, and boards' });
  await input.pressSequentially('boa', { delay: 180 });
  await film.dwell(1900);
  // Enter navigates to the top result.
  await p.keyboard.press('Enter');
  await film.dwell(1600);

  // Shortcuts overlay via "?" (Playwright maps the char via Shift+Slash, not Shift+/).
  await p.keyboard.press('Shift+Slash');
  const help = p.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await help.waitFor({ timeout: 8000 }).catch(() => {});
  await film.dwell(2600);
  await p.keyboard.press('Escape');
  await film.dwell(800);
}
