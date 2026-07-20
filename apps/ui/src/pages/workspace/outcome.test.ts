// Dual-outcome derivation (Sprint 7 P0 stage 4): execution vs coverage, purely
// from RunView (D5), for BOTH fixture shapes — a v2.4 stream with a declared
// registry (full and partial coverage) and a pre-v2.4 stream without one
// (records/bmp180-run's shape), which must report coverage WITHOUT a
// denominator, never an invented one.
import { describe, expect, it } from 'vitest';
import type { Event } from '@boardex/contract';
import { artifactOf, checkOf, envelope, run, viewFrom } from './test-events';
import { coverageLine, deriveDualOutcome, executionLabel } from './outcome';

const REGISTRY = [
  { requirementId: 'build_exit_code', description: 'Build exits 0' },
  { requirementId: 'device_ack', description: 'ACK at 0x76' },
  { requirementId: 'i2c_clock', description: 'SCL 100 kHz ±10%' },
  { requirementId: 'serial_output', description: 'TEMP/HUM on serial' },
  { requirementId: 'temperature_plausible', description: 'Temp 15–35 °C' },
  { requirementId: 'humidity_plausible', description: 'Hum 20–80 %RH' },
];

function planWithRegistry(seq: number): Event {
  return envelope(seq, 'run.plan_generated', {
    plan: [],
    riskSummary: 'risk',
    checks: REGISTRY,
  });
}

function recorded(seq: number, id: string, requirementId: string): Event[] {
  return [
    envelope(seq, 'artifact.created', { artifact: artifactOf(`art_${id}`, 'build_log') }),
    envelope(seq + 1, 'check.evaluated', {
      check: checkOf(`chk_${id}`, requirementId, `art_${id}`, 'pass'),
    }),
  ];
}

describe('deriveDualOutcome', () => {
  it('is null while the run is non-terminal — the split exists only with an outcome', () => {
    expect(deriveDualOutcome(viewFrom([envelope(1, 'run.created', { run })]))).toBeNull();
  });

  it('partial coverage with a registry: recorded vs registered, the rest not recorded', () => {
    const view = viewFrom([
      envelope(1, 'run.created', { run }),
      planWithRegistry(2),
      ...recorded(3, 'build', 'build_exit_code'),
      ...recorded(5, 'ack', 'device_ack'),
      envelope(7, 'run.failed', {
        summary: 'Run terminated by harness: turn bound exceeded: max_turns=40',
      }),
    ]);
    const outcome = deriveDualOutcome(view);
    expect(outcome).not.toBeNull();
    if (!outcome) return;
    expect(outcome.execution).toEqual({
      status: 'failed',
      reason: 'Run terminated by harness: turn bound exceeded: max_turns=40',
    });
    expect(outcome.coverage).toMatchObject({ kind: 'registered', recorded: 2, registered: 6 });
    if (outcome.coverage.kind !== 'registered') return;
    expect(outcome.coverage.notRecorded.map((expectation) => expectation.requirementId)).toEqual([
      'i2c_clock',
      'serial_output',
      'temperature_plausible',
      'humidity_plausible',
    ]);
    expect(coverageLine(outcome.coverage)).toBe('2 of 6 checks recorded');
    expect(executionLabel(outcome)).toBe('Failed');
  });

  it('full coverage on a completed run reads full, with nothing not-recorded', () => {
    const view = viewFrom([
      envelope(1, 'run.created', { run }),
      envelope(2, 'run.plan_generated', {
        plan: [],
        riskSummary: 'risk',
        checks: REGISTRY.slice(0, 2),
      }),
      ...recorded(3, 'build', 'build_exit_code'),
      ...recorded(5, 'ack', 'device_ack'),
      envelope(7, 'run.completed', { summary: 'All checks pass.', reportArtifactId: 'art_build' }),
    ]);
    const outcome = deriveDualOutcome(view);
    if (!outcome || outcome.coverage.kind !== 'registered') throw new Error('expected registry');
    expect(outcome.coverage).toMatchObject({ recorded: 2, registered: 2 });
    expect(outcome.coverage.notRecorded).toEqual([]);
    expect(coverageLine(outcome.coverage)).toBe('2 of 2 checks recorded');
    expect(outcome.execution.reason).toBe('All checks pass.');
  });

  it('no registry (pre-v2.4 recording): coverage has NO denominator and nothing is invented', () => {
    const view = viewFrom([
      envelope(1, 'run.created', { run }),
      ...recorded(2, 'build', 'build_exit_code'),
      ...recorded(4, 'ack', 'chip_id_rtt'),
      envelope(6, 'run.failed', { summary: 'turn bound exceeded: max_turns=40' }),
    ]);
    const outcome = deriveDualOutcome(view);
    expect(outcome?.coverage).toEqual({ kind: 'unregistered', recorded: 2 });
    if (!outcome || outcome.coverage.kind !== 'unregistered') return;
    expect(coverageLine(outcome.coverage)).toBe(
      '2 checks recorded · no check registry declared',
    );
  });

  it('a stopped run carries no reason — byUser is the whole story', () => {
    const view = viewFrom([
      envelope(1, 'run.created', { run }),
      envelope(2, 'run.stopped', { byUser: true }),
    ]);
    const outcome = deriveDualOutcome(view);
    expect(outcome?.execution).toEqual({ status: 'stopped', reason: null });
    expect(executionLabel(outcome as NonNullable<typeof outcome>)).toBe('Stopped');
  });
});
