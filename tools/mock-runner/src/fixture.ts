// Loads the authored BME280 fixture (BIBLE §5.5) and the artifact files that back
// it. The fixture is one JSON object per line: { delayMs, event }. delayMs is the
// mock's replay pacing (§5.5) and is stripped before an event goes on the wire.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ArtifactSchema,
  EventSchema,
  type Artifact,
  type ArtifactKind,
  type Event,
} from '@boardex/contract';

export interface FixtureEntry {
  delayMs: number;
  event: Event;
}

// The runId every fixture event carries; re-keyed to a fresh id per run session.
export const FIXTURE_RUN_ID = 'run_bme280_001';

// The fixture and its artifacts live in the contract package (§3). Resolve them
// relative to this file so the path holds regardless of the process cwd. The base
// goes through a variable because bundlers (Vite) statically rewrite the literal
// `new URL('...', import.meta.url)` pattern into an http asset URL, which breaks
// this node-only path resolution when the runner is embedded in a browser-flavored
// test host (the UI's jsdom integration tests).
const moduleUrl = import.meta.url;
const FIXTURES_DIR = fileURLToPath(new URL('../../../packages/contract/fixtures/', moduleUrl));
const FIXTURE_FILE = FIXTURES_DIR + 'bme280_run_001.jsonl';
const ARTIFACTS_DIR = FIXTURES_DIR + 'artifacts/';

// Artifact file extension by kind — logs are text, structured kinds are JSON,
// the report is Markdown, raw captures are sigrok .sr (none in this fixture).
const EXTENSION_BY_KIND: Record<ArtifactKind, string> = {
  serial_log: '.log',
  build_log: '.log',
  flash_log: '.log',
  logic_capture: '.sr',
  protocol_decode: '.json',
  code_diff: '.json',
  timing_measurement: '.json',
  report_md: '.md',
};

export function loadFixture(): FixtureEntry[] {
  const text = readFileSync(FIXTURE_FILE, 'utf8');
  const entries: FixtureEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as { delayMs: number; event: unknown };
    entries.push({ delayMs: parsed.delayMs, event: EventSchema.parse(parsed.event) });
  }
  return entries;
}

export interface ArtifactFile {
  meta: Artifact;
  filePath: string;
}

// Build a catalog of every artifact the fixture references, keyed by artifact id
// (artifact ids do not contain the runId, so they are stable across run sessions).
// Content is served from the file at ARTIFACTS_DIR/{id}{ext}.
export function buildArtifactCatalog(entries: readonly FixtureEntry[]): Map<string, ArtifactFile> {
  const catalog = new Map<string, ArtifactFile>();
  for (const { event } of entries) {
    if (event.type !== 'artifact.created') continue;
    const meta = ArtifactSchema.parse(event.payload.artifact);
    const filePath = ARTIFACTS_DIR + meta.id + EXTENSION_BY_KIND[meta.kind];
    catalog.set(meta.id, { meta, filePath });
  }
  return catalog;
}
