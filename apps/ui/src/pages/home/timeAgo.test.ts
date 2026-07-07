import { describe, expect, it } from 'vitest';
import { timeAgo } from './timeAgo';

const NOW = Date.parse('2026-07-07T12:00:00.000Z');

describe('timeAgo', () => {
  it('reads "just now" under a minute', () => {
    expect(timeAgo('2026-07-07T11:59:30.000Z', NOW)).toBe('just now');
  });

  it('rounds down to whole minutes and hours', () => {
    expect(timeAgo('2026-07-07T11:58:00.000Z', NOW)).toBe('2m ago');
    expect(timeAgo('2026-07-07T09:30:00.000Z', NOW)).toBe('2h ago');
  });

  it('reads whole days within a week', () => {
    expect(timeAgo('2026-07-04T12:00:00.000Z', NOW)).toBe('3d ago');
  });

  it('falls back to an absolute date past a week', () => {
    // Older than 7 days → a short month/day date, not a day count.
    expect(timeAgo('2026-05-01T12:00:00.000Z', NOW)).not.toMatch(/ago/);
  });

  it('returns empty for an unparseable timestamp', () => {
    expect(timeAgo('not-a-date', NOW)).toBe('');
  });
});
