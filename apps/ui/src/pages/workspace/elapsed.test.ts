// Elapsed-timer derivation (T2.2): formatted from run.createdAt against a wall
// clock, clamped at zero, null on unparseable input, and terminal-status detection.
import { describe, expect, it } from 'vitest';
import { elapsedLabel, isTerminalStatus } from './elapsed';

const T0 = Date.parse('2026-07-08T12:00:00.000Z');
const at = (seconds: number): number => T0 + seconds * 1000;

describe('elapsedLabel', () => {
  it('formats minutes and seconds', () => {
    expect(elapsedLabel('2026-07-08T12:00:00.000Z', at(0))).toBe('0:00');
    expect(elapsedLabel('2026-07-08T12:00:00.000Z', at(5))).toBe('0:05');
    expect(elapsedLabel('2026-07-08T12:00:00.000Z', at(65))).toBe('1:05');
    expect(elapsedLabel('2026-07-08T12:00:00.000Z', at(59 * 60 + 59))).toBe('59:59');
  });

  it('switches to hours past one hour', () => {
    expect(elapsedLabel('2026-07-08T12:00:00.000Z', at(3600))).toBe('1:00:00');
    expect(elapsedLabel('2026-07-08T12:00:00.000Z', at(3600 + 62))).toBe('1:01:02');
    expect(elapsedLabel('2026-07-08T12:00:00.000Z', at(10 * 3600 + 59))).toBe('10:00:59');
  });

  it('truncates sub-second progress rather than rounding up', () => {
    expect(elapsedLabel('2026-07-08T12:00:00.000Z', at(4) + 900)).toBe('0:04');
  });

  it('clamps clock skew (createdAt in the future) to zero', () => {
    expect(elapsedLabel('2026-07-08T12:00:10.000Z', at(0))).toBe('0:00');
  });

  it('returns null for an unparseable createdAt', () => {
    expect(elapsedLabel('not-a-timestamp', at(0))).toBeNull();
  });
});

describe('isTerminalStatus', () => {
  it.each(['completed', 'failed', 'stopped'] as const)('%s is terminal', (status) => {
    expect(isTerminalStatus(status)).toBe(true);
  });

  it.each([
    'draft',
    'planning',
    'plan_ready',
    'running',
    'awaiting_approval',
    'diagnosing',
  ] as const)('%s is not terminal', (status) => {
    expect(isTerminalStatus(status)).toBe(false);
  });
});
