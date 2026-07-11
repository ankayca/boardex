// Expected-window and actual-value formatting (§7.4 Checks tab) — every shape
// §4 allows: min/max, min-only, max-only, equals (boolean and string), pattern,
// combinations, and the empty window.
import { describe, expect, it } from 'vitest';
import { formatActual, formatExpected } from './checksTable';

describe('formatExpected', () => {
  it('renders a min+max window as a range with the measurement unit', () => {
    expect(formatExpected({ min: 90000, max: 110000 }, 'Hz')).toBe('90,000 – 110,000 Hz');
  });

  it('renders min-only and max-only bounds', () => {
    expect(formatExpected({ min: 5 }, 'V')).toBe('≥ 5 V');
    expect(formatExpected({ max: 3 })).toBe('≤ 3');
  });

  it('renders boolean equals', () => {
    expect(formatExpected({ equals: true })).toBe('= true');
    expect(formatExpected({ equals: false })).toBe('= false');
  });

  it('renders string equals quoted', () => {
    expect(formatExpected({ equals: 'ok' })).toBe('= “ok”');
  });

  it('renders a pattern', () => {
    expect(formatExpected({ pattern: 'TEMP=\\d+\\.\\d HUM=\\d+\\.\\d' })).toBe(
      'matches TEMP=\\d+\\.\\d HUM=\\d+\\.\\d',
    );
  });

  it('joins combined constraints', () => {
    expect(formatExpected({ min: 1, max: 2, pattern: 'x' })).toBe('1 – 2 and matches x');
  });

  it('renders an empty window as an em dash, never an empty cell', () => {
    expect(formatExpected({})).toBe('—');
  });
});

describe('formatActual', () => {
  it('renders numbers with the unit', () => {
    expect(formatActual({ value: 99600, unit: 'Hz' })).toBe('99,600 Hz');
  });

  it('renders booleans and unitless strings as-is', () => {
    expect(formatActual({ value: false })).toBe('false');
    expect(formatActual({ value: 'no TEMP/HUM line in 60 s of output' })).toBe(
      'no TEMP/HUM line in 60 s of output',
    );
  });
});
