// Loads the authored BME280 fixture (BIBLE §5.5) and the artifact files that back
// it. The fixture is one JSON object per line: { delayMs, event }. delayMs is the
// mock's replay pacing (§5.5) and is stripped before an event goes on the wire.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
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
// <checkout>/ — the mock lives at tools/mock-runner/src, so three levels up.
const REPO_ROOT = fileURLToPath(new URL('../../../', moduleUrl));
const FIXTURES_DIR = REPO_ROOT + 'packages/contract/fixtures/';
const ARTIFACTS_DIR = FIXTURES_DIR + 'artifacts/';

// The two authored stories (§5.5 + the T5.0/F9 fail variant: identical through
// iteration-2's flash, then the checks fail again and the run ends in run.failed
// with no further fix approval).
export type FixtureVariant = 'default' | 'fail';

const FIXTURE_FILE_BY_VARIANT: Record<FixtureVariant, string> = {
  default: FIXTURES_DIR + 'bme280_run_001.jsonl',
  fail: FIXTURES_DIR + 'bme280_run_001_fail.jsonl',
};

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

function parseEntries(text: string): FixtureEntry[] {
  const entries: FixtureEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as { delayMs: number; event: unknown };
    entries.push({ delayMs: parsed.delayMs, event: EventSchema.parse(parsed.event) });
  }
  return entries;
}

export function loadFixture(variant: FixtureVariant = 'default'): FixtureEntry[] {
  return parseEntries(readFileSync(FIXTURE_FILE_BY_VARIANT[variant], 'utf8'));
}

export interface LoadedFixture {
  entries: FixtureEntry[];
  // Where buildArtifactCatalog resolves this recording's artifact bodies.
  artifactsDir: string;
}

// FIXTURE_FILE override (§10.3): replay an arbitrary recorded run — e.g. a real
// hardware agent run under records/ — instead of the authored contract fixtures.
// A relative path resolves against the repo root, so `FIXTURE_FILE=records/...`
// works regardless of the process cwd (npm runs the workspace script from the
// package dir). Artifact bodies are served from the recording's own sibling
// artifacts/ directory, referenced by id exactly like the authored fixtures.
export function loadFixtureFile(fixtureFile: string): LoadedFixture {
  const filePath = isAbsolute(fixtureFile) ? fixtureFile : resolve(REPO_ROOT, fixtureFile);
  return {
    entries: parseEntries(readFileSync(filePath, 'utf8')),
    artifactsDir: dirname(filePath) + '/artifacts/',
  };
}

export interface ArtifactFile {
  meta: Artifact;
  filePath: string;
}

// Build a catalog of every artifact the fixture references, keyed by artifact id
// (artifact ids do not contain the runId, so they are stable across run sessions).
// Content is served from the file at ARTIFACTS_DIR/{id}{ext}.
export function buildArtifactCatalog(
  entries: readonly FixtureEntry[],
  artifactsDir: string = ARTIFACTS_DIR,
): Map<string, ArtifactFile> {
  const catalog = new Map<string, ArtifactFile>();
  for (const { event } of entries) {
    if (event.type !== 'artifact.created') continue;
    const meta = ArtifactSchema.parse(event.payload.artifact);
    const filePath = artifactsDir + meta.id + EXTENSION_BY_KIND[meta.kind];
    catalog.set(meta.id, { meta, filePath });
  }
  return catalog;
}
