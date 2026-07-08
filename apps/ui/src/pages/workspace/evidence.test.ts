// Evidence band derivation (BIBLE §7.3): the short-name humanizer, the real-artifact
// targets for Open Logs/Diff/Report, and the chip source — view.checks in the
// reducer's order, including iteration-2 replace-in-place and the evidence-law
// needs_review downgrade. Views are always the real reduceRun output (D5).
import { describe, expect, it } from 'vitest';
import type { Event, RunView } from '@boardex/contract';
import { checkLabel, evidenceHref, evidenceTargets } from './evidence';
import { artifactOf, checkOf, envelope, run, viewFrom } from './test-events';

// Number a list of (type, payload) pairs into a gapless seq stream starting at
// run.created, then reduce it — the reducer is the one derivation path.
function reduce(
  events: { type: Event['type']; payload: unknown }[],
): RunView {
  const stream: Event[] = [
    envelope(1, 'run.created', { run }),
    ...events.map((e, i) =>
      envelope(i + 2, e.type as never, e.payload as never),
    ),
  ];
  return viewFrom(stream);
}

describe('checkLabel', () => {
  it('humanizes a requirementId: separators to spaces, digit tokens uppercased, first letter capitalized', () => {
    expect(checkLabel('i2c_clock')).toBe('I2C clock');
    expect(checkLabel('device_ack')).toBe('Device ack');
    expect(checkLabel('serial_output')).toBe('Serial output');
    expect(checkLabel('spi3-bus-ready')).toBe('SPI3 bus ready');
  });
});

describe('evidenceHref', () => {
  it('targets the Sprint-3 evidence route, byte-identical to the Diagnosis Card stub links', () => {
    expect(evidenceHref('run_x', 'art_1')).toBe('/runs/run_x/evidence?artifact=art_1');
  });
});

describe('evidenceTargets', () => {
  it('resolves the most recent artifact of each kind, preferring the serial log for Open Logs', () => {
    const view = reduce([
      { type: 'artifact.created', payload: { artifact: artifactOf('art_build', 'build_log') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_diff_1', 'code_diff') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_serial_1', 'serial_log') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_diff_2', 'code_diff') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_serial_2', 'serial_log') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_report', 'report_md') } },
    ]);
    expect(evidenceTargets(view)).toEqual({
      logs: 'art_serial_2', // last serial_log wins over the earlier one and over build_log
      diff: 'art_diff_2',
      report: 'art_report',
    });
  });

  it('falls back to build then flash logs when no serial log exists, and nulls absent kinds', () => {
    const view = reduce([
      { type: 'artifact.created', payload: { artifact: artifactOf('art_flash', 'flash_log') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_build', 'build_log') } },
    ]);
    expect(evidenceTargets(view)).toEqual({ logs: 'art_build', diff: null, report: null });
  });

  it('nulls every target before any artifact exists', () => {
    const view = reduce([]);
    expect(evidenceTargets(view)).toEqual({ logs: null, diff: null, report: null });
  });
});

describe('chip source: view.checks (the reducer, not re-derived)', () => {
  it('carries pass/fail/needs_review verdicts in evaluation order', () => {
    const view = reduce([
      { type: 'artifact.created', payload: { artifact: artifactOf('art_clock', 'timing_measurement') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_ack', 'protocol_decode') } },
      { type: 'check.evaluated', payload: { check: checkOf('chk_clock', 'i2c_clock', 'art_clock', 'pass') } },
      { type: 'check.evaluated', payload: { check: checkOf('chk_ack', 'device_ack', 'art_ack', 'fail') } },
      // No prior artifact.created for art_missing → evidence-law downgrade to needs_review.
      { type: 'check.evaluated', payload: { check: checkOf('chk_serial', 'serial_output', 'art_missing', 'fail') } },
    ]);
    expect(view.checks.map((c) => [c.requirementId, c.verdict])).toEqual([
      ['i2c_clock', 'pass'],
      ['device_ack', 'fail'],
      ['serial_output', 'needs_review'],
    ]);
  });

  it('replaces an iteration-1 check in place on iteration-2 re-evaluation (same id, new verdict + artifact)', () => {
    const view = reduce([
      { type: 'artifact.created', payload: { artifact: artifactOf('art_clock_1', 'timing_measurement') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_ack_1', 'protocol_decode') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_serial_1', 'serial_log') } },
      { type: 'check.evaluated', payload: { check: checkOf('chk_clock', 'i2c_clock', 'art_clock_1', 'pass') } },
      { type: 'check.evaluated', payload: { check: checkOf('chk_ack', 'device_ack', 'art_ack_1', 'fail') } },
      { type: 'check.evaluated', payload: { check: checkOf('chk_serial', 'serial_output', 'art_serial_1', 'fail') } },
      { type: 'run.iteration_started', payload: { iteration: 2, reason: 'apply address fix' } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_clock_2', 'timing_measurement') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_ack_2', 'protocol_decode') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_serial_2', 'serial_log') } },
      { type: 'check.evaluated', payload: { check: checkOf('chk_clock', 'i2c_clock', 'art_clock_2', 'pass') } },
      { type: 'check.evaluated', payload: { check: checkOf('chk_ack', 'device_ack', 'art_ack_2', 'pass') } },
      { type: 'check.evaluated', payload: { check: checkOf('chk_serial', 'serial_output', 'art_serial_2', 'pass') } },
    ]);
    // Three chips, not six — re-evaluation replaces in place and keeps evaluation order.
    expect(view.checks.map((c) => c.id)).toEqual(['chk_clock', 'chk_ack', 'chk_serial']);
    expect(view.checks.every((c) => c.verdict === 'pass')).toBe(true);
    expect(view.checks.map((c) => c.artifactId)).toEqual(['art_clock_2', 'art_ack_2', 'art_serial_2']);
  });
});
