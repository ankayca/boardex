// Cross-segment scratch state. seg34 creates the run and records its id here; the
// evidence/report segments read it back to inspect the same completed run. Lives in
// the OUT dir alongside the raw captures (both throwaway).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = process.env.OUT || join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const FILE = join(OUT, 'runid.txt');

export function setRunId(id) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(FILE, String(id), 'utf8');
}

export function getRunId() {
  try {
    return readFileSync(FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}
