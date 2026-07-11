// Fixture validation (T0.3): every line of bme280_run_001.jsonl must parse,
// validate against the event union, and reduce to the completed run the BIBLE
// §5.5 story promises. This test is the acceptance gate the recorded fixture
// (§10.3) must also pass, unmodified.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CodeDiffContentSchema,
  ProtocolDecodeContentSchema,
  TimingMeasurementContentSchema,
} from './artifacts';
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
    const view = reduceRun(events)!;

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
    const view = reduceRun(events)!;
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

  it('every structured artifact file validates against its promoted content schema (T5.0/F2)', () => {
    const view = reduceRun(events)!;
    const schemaByKind = {
      protocol_decode: ProtocolDecodeContentSchema,
      code_diff: CodeDiffContentSchema,
      timing_measurement: TimingMeasurementContentSchema,
    } as const;

    const structured = view.artifacts.filter(
      (artifact): artifact is (typeof view.artifacts)[number] & { kind: keyof typeof schemaByKind } =>
        artifact.kind in schemaByKind,
    );
    // The story ships 2 decodes, 2 diffs and 2 timing measurements.
    expect(structured).toHaveLength(6);

    for (const artifact of structured) {
      const content: unknown = JSON.parse(
        readFileSync(join(artifactsDir, `${artifact.id}.json`), 'utf8'),
      );
      const result = schemaByKind[artifact.kind].safeParse(content);
      expect(
        result.success,
        `${artifact.id} (${artifact.kind}): ${result.success ? '' : result.error.message}`,
      ).toBe(true);
    }
  });

  it('decode annotations are the house parser shape — raw line plus parsed fields', () => {
    // Reconciled in T5.0/F2 to parse.py::parse_annotations output; the invented
    // start_sample/end_sample keys are gone.
    for (const id of ['art_i2c_decode_iter1', 'art_i2c_decode_iter2', 'art_i2c_decode_iter2f']) {
      const content = ProtocolDecodeContentSchema.parse(
        JSON.parse(readFileSync(join(artifactsDir, `${id}.json`), 'utf8')),
      );
      expect(content.annotations.length).toBeGreaterThan(0);
      for (const annotation of content.annotations) {
        expect(annotation.raw).toBe(
          `${annotation.start}-${annotation.end} ${annotation.decoder}: ${annotation.text}`,
        );
      }
    }
  });
});

describe('bme280_run_001_fail fixture (T5.0/F9 — the fail variant)', () => {
  const failLines = readFileSync(join(fixturesDir, 'bme280_run_001_fail.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  const failEvents: Event[] = failLines.map((line, i) => {
    const result = FixtureLineSchema.safeParse(JSON.parse(line));
    if (!result.success) {
      throw new Error(`fail-variant line ${i + 1} invalid: ${result.error.message}`);
    }
    return result.data.event;
  });

  it('shares the base story verbatim through seq 68 (iteration-2 flash complete)', () => {
    for (let i = 0; i < 68; i++) {
      expect(failEvents[i]).toEqual(events[i]);
    }
  });

  it('has gapless seq and ends in run.failed with NO further approval requested', () => {
    failEvents.forEach((event, i) => {
      expect(event.seq).toBe(i + 1);
    });
    expect(failEvents[failEvents.length - 1]?.type).toBe('run.failed');
    // "without a fix approval": no approval.requested after iteration 2's checks fail.
    const approvalSeqs = failEvents
      .filter((event) => event.type === 'approval.requested')
      .map((event) => event.seq);
    expect(approvalSeqs.every((seq) => seq <= 68)).toBe(true);
  });

  it('reduces to the failed terminal: iteration 2, 2 approvals approved, pass/fail/fail checks, zero warnings', () => {
    const view = reduceRun(failEvents)!;
    expect(view.run.status).toBe('failed');
    expect(view.endedAt).toBe(failEvents[failEvents.length - 1]?.ts);
    expect(view.run.iteration).toBe(2);
    expect(view.warnings).toEqual([]);
    expect(view.approvals).toHaveLength(2);
    expect(view.approvals.every((approval) => approval.status === 'approved')).toBe(true);

    const verdicts = new Map(view.checks.map((check) => [check.requirementId, check.verdict]));
    expect(verdicts.get('i2c_clock')).toBe('pass');
    expect(verdicts.get('device_ack')).toBe('fail');
    expect(verdicts.get('serial_output')).toBe('fail');
  });

  it('iter2f serial log carries the strings the evidenced firmware actually prints (T5.0 FIX_FIRST F2)', () => {
    // The iteration-2 driver (art_diff_iter2) has no NACKF handling: an address
    // NACK leaves TXIS unset and i2c1_wait times out — over UART, the corrected
    // address facing dead hardware is indistinguishable from iteration 1's wrong
    // address. Only the logic-analyzer decode can tell them apart; that is the
    // fail variant's whole story.
    const iter1 = readFileSync(join(artifactsDir, 'art_serial_log_iter1.log'), 'utf8');
    const iter2f = readFileSync(join(artifactsDir, 'art_serial_log_iter2f.log'), 'utf8');
    expect(iter2f).toContain('I2C1 ERROR: timeout waiting for TXIS (read setup)');
    expect(iter2f).not.toMatch(/NACKF/); // the firmware never reads, let alone prints, NACKF
    // Identical failure signature line-for-line: same probe loop, same wait path.
    const errorLines = (log: string) =>
      log.split('\n').filter((line) => line.includes('ERROR') || line.includes('FATAL'));
    expect(errorLines(iter2f)).toEqual(errorLines(iter1));

    // The live stream (seq 77 step.log) mirrors the artifact, not a divergent story.
    const seq77 = failEvents.find((event) => event.seq === 77);
    expect(seq77?.type).toBe('step.log');
    if (seq77?.type === 'step.log' && 'lines' in seq77.payload) {
      expect(seq77.payload.lines.length).toBeGreaterThan(0);
      for (const line of seq77.payload.lines) {
        expect(iter2f).toContain(line);
      }
    }
  });

  it('links every artifact to a real fixture file with matching size, contents schema-valid', () => {
    const view = reduceRun(failEvents)!;
    const files = readdirSync(artifactsDir);
    for (const artifact of view.artifacts) {
      const file = files.find((name) => name.replace(/\.[^.]+$/, '') === artifact.id);
      expect(file, `artifact file for ${artifact.id}`).toBeDefined();
      expect(statSync(join(artifactsDir, file as string)).size).toBe(artifact.sizeBytes);
    }
    const decode = ProtocolDecodeContentSchema.parse(
      JSON.parse(readFileSync(join(artifactsDir, 'art_i2c_decode_iter2f.json'), 'utf8')),
    );
    // The story's point: the CORRECTED wire byte (0x76 << 1 = 0xEC) still NACKs.
    expect(decode.transactions.every((tx) => tx.addr_7bit === 0x76 && tx.nack_at === 'address')).toBe(true);
    TimingMeasurementContentSchema.parse(
      JSON.parse(readFileSync(join(artifactsDir, 'art_scl_timing_iter2f.json'), 'utf8')),
    );
  });
});
