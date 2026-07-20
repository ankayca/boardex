// record.mjs — orchestrates the Boardex walkthrough shoot (chore/demo-video).
//
// Usage:  NODE_PATH=<scratchpad>/node_modules node record.mjs [seg1 seg2 ...|all]
//   OUT=<dir>        where raw per-segment webm captures land (default ./out)
//   UI_URL           default http://localhost:5356
//   RUNNER_URL       default http://localhost:4356
//
// Segments are independent modules under ./segments; each default-exports an async
// driver (film) => {}. They share the mock-runner run state on the server, so order
// matters where noted (3-4 creates the run 5/6 inspect). See SHOTLIST for the arc.

import { mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { shoot } from './lib/cinema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || join(HERE, 'out');

// Ordered roster. Each entry: [key, module, {permissions}].
const ROSTER = [
  ['seg1', 'segments/seg1-home.mjs'],
  ['seg2', 'segments/seg2-demo.mjs'],
  ['seg34', 'segments/seg34-run.mjs'],
  ['seg5', 'segments/seg5-evidence.mjs'],
  ['seg6', 'segments/seg6-report.mjs', { permissions: ['clipboard-read', 'clipboard-write'] }],
  ['seg7', 'segments/seg7-boards-settings.mjs'],
  ['seg8', 'segments/seg8-keyboard.mjs'],
  ['seg9', 'segments/seg9-real.mjs'],
];

const want = process.argv.slice(2);
const runAll = want.length === 0 || want.includes('all');
const selected = ROSTER.filter(([k]) => runAll || want.includes(k));

mkdirSync(OUT, { recursive: true });

const results = [];
for (const [key, mod, opts = {}] of selected) {
  process.stdout.write(`\n▶ ${key} … `);
  const { default: driver } = await import('./' + mod);
  const r = await shoot(key, OUT, driver, opts);
  // Rename the hashed Playwright capture to a stable per-segment name for stitching.
  if (r.rawPath) {
    const stable = join(OUT, `${key}.webm`);
    try { renameSync(r.rawPath, stable); r.rawPath = stable; } catch { /* keep raw */ }
  }
  results.push(r);
  if (r.failure) {
    process.stdout.write(`FAILED: ${r.failure.message}\n`);
  } else {
    process.stdout.write(`ok → ${r.rawPath}\n`);
  }
  if (r.errors.length) {
    process.stdout.write(`  console errors (${r.errors.length}):\n`);
    for (const e of r.errors.slice(0, 8)) process.stdout.write('    ! ' + e + '\n');
  }
}

console.log('\n=== shoot summary ===');
for (const r of results) {
  console.log(
    `${r.name}: ${r.failure ? 'FAIL(' + r.failure.message + ')' : 'ok'} · ` +
      `${r.errors.length} console errs · ${r.rawPath || 'no video'}`,
  );
}
const anyFail = results.some((r) => r.failure);
process.exit(anyFail ? 1 : 0);
