// Fixture validation (T0.3): every line of bme280_run_001.jsonl must parse,
// validate against the event union, and reduce to the completed run the BIBLE
// §5.5 story promises. This test is the acceptance gate the recorded fixture
// (§10.3) must also pass, unmodified.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventSchema, type Event } from './events';
import { reduceRun } from './reducer';

const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));
const artifactsDir = join(fixturesDir, 'artifacts');

// §5.5: one JSON event per line plus the replay pacing field; delayMs is capped
// at 20s per T0.3 so demo pacing never stalls.
const FixtureLineSchema = z.object({
  delayMs: z.number().int().min(0).max(20000),
  event: EventSchema,
});

const lines = readFileSync(join(fixturesDir, 'bme280_run_001.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.length > 0);

const parsed = lines.map((line, i) => {
  const result = FixtureLineSchema.safeParse(JSON.parse(line));
  if (!result.success) {
    throw new Error(`fixture line ${i + 1} invalid: ${result.error.message}`);
  }
  return result.data;
});
const events: Event[] = parsed.map((entry) => entry.event);

describe('bme280_run_001 fixture', () => {
  it('has a plausible size and every line validates against the event union', () => {
    // Parsing/validation happened above; this pins the story's rough shape.
    expect(events.length).toBeGreaterThan(50);
  });

  it('has gapless seq starting at 1 and non-decreasing timestamps (~11 min run)', () => {
    events.forEach((event, i) => {
      expect(event.seq).toBe(i + 1);
    });
    const times = events.map((event) => Date.parse(event.ts));
    times.forEach((t, i) => {
      expect(Number.isNaN(t)).toBe(false);
      if (i > 0) {
        expect(t).toBeGreaterThanOrEqual(times[i - 1] ?? 0);
      }
    });
    const spanMinutes = ((times[times.length - 1] ?? 0) - (times[0] ?? 0)) / 60_000;
    expect(spanMinutes).toBeGreaterThan(9);
    expect(spanMinutes).toBeLessThan(13);
  });

  it('reduces to the §5.5 story: completed, 2 approvals resolved, iteration 2, 3 passing checks, zero warnings', () => {
    const view = reduceRun(events);

    expect(view.run.status).toBe('completed');
    expect(view.warnings).toEqual([]);

    expect(view.approvals).toHaveLength(2);
    for (const approval of view.approvals) {
      expect(approval.status).toBe('approved');
      expect(approval.resolvedAt).toBeDefined();
    }

    // Iteration reaches 2 via the run.iteration_started event (bible v1.2).
    const iterationEvents = events.filter((event) => event.type === 'run.iteration_started');
    expect(iterationEvents).toHaveLength(1);
    expect(iterationEvents[0]?.payload.iteration).toBe(2);
    expect(iterationEvents[0]?.payload.reason).toMatch(/address/i);
    expect(view.run.iteration).toBe(2);

    expect(view.checks).toHaveLength(3);
    expect(view.checks.map((check) => check.requirementId).sort()).toEqual([
      'device_ack',
      'i2c_clock',
      'serial_output',
    ]);
    for (const check of view.checks) {
      expect(check.verdict).toBe('pass');
    }

    // The failure/diagnosis arc actually happened before the passing end state.
    const failedVerdicts = events.filter(
      (event) => event.type === 'check.evaluated' && event.payload.check.verdict === 'fail',
    );
    expect(failedVerdicts).toHaveLength(2);
    expect(view.diagnosis).toBeDefined();
    expect(view.run.plan).toHaveLength(6);
  });

  it('links every check to a real artifact and every artifact to a real fixture file with matching size', () => {
    const view = reduceRun(events);
    const artifactIds = new Set(view.artifacts.map((artifact) => artifact.id));
    for (const check of view.checks) {
      expect(artifactIds.has(check.artifactId)).toBe(true);
    }

    const files = readdirSync(artifactsDir);
    for (const artifact of view.artifacts) {
      const file = files.find((name) => name.replace(/\.[^.]+$/, '') === artifact.id);
      expect(file, `artifact file for ${artifact.id}`).toBeDefined();
      expect(statSync(join(artifactsDir, file as string)).size).toBe(artifact.sizeBytes);
    }
  });
});
