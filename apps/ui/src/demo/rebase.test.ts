import { describe, expect, it } from 'vitest';
import { isKnownEvent } from '@boardex/contract';
import { DEMO_ENTRIES } from './data/demoRun';
import { rebaseEntries } from './rebase';

const NOW = Date.parse('2026-07-14T16:00:00.000Z');

describe('rebaseEntries', () => {
  it('lands the first event at nowMs and preserves every inter-event delta', () => {
    const rebased = rebaseEntries(DEMO_ENTRIES, NOW);
    expect(Date.parse(rebased[0]!.event.ts)).toBe(NOW);

    // Deltas between successive envelope timestamps are unchanged by the shift.
    for (let i = 1; i < rebased.length; i++) {
      const before = Date.parse(DEMO_ENTRIES[i]!.event.ts) - Date.parse(DEMO_ENTRIES[i - 1]!.event.ts);
      const after = Date.parse(rebased[i]!.event.ts) - Date.parse(rebased[i - 1]!.event.ts);
      expect(after).toBe(before);
    }
  });

  it('shifts run.createdAt too, so elapsed is measured from now', () => {
    const rebased = rebaseEntries(DEMO_ENTRIES, NOW);
    const created = rebased[0]!.event;
    expect(isKnownEvent(created) && created.type === 'run.created').toBe(true);
    if (isKnownEvent(created) && created.type === 'run.created') {
      expect(Date.parse(created.payload.run.createdAt)).toBe(NOW);
    }
  });

  it('leaves non-timestamp strings (log lines, values) untouched', () => {
    // A step.log line carries free text with digits that must never be rewritten. Its
    // payload holds no timestamps, so a rebased log event differs ONLY in its envelope
    // ts — everything else (the line text) is byte-identical.
    const index = DEMO_ENTRIES.findIndex(
      (entry) => isKnownEvent(entry.event) && entry.event.type === 'step.log',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const rebased = rebaseEntries(DEMO_ENTRIES, NOW)[index]!.event;
    const original = DEMO_ENTRIES[index]!.event;
    expect({ ...rebased, ts: '' }).toEqual({ ...original, ts: '' });
  });
});
