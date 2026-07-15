// The tour's moment-anchoring (T6.5). Reducing successive prefixes of the real
// recording must move highestReached forward through the six moments in occurrence
// order — never backward, and each step latches exactly when its moment lands.
import { describe, expect, it } from 'vitest';
import { reduceRun, type RunView } from '@boardex/contract';
import { DEMO_ENTRIES } from './data/demoRun';
import { TOUR_STEPS, highestReached } from './tour';

const events = DEMO_ENTRIES.map((entry) => entry.event);

// Reduce the prefix [1..k]; the entries are already seq-ordered and gapless.
const viewAt = (k: number): RunView | null => reduceRun(events.slice(0, k));

describe('tour moment anchoring', () => {
  it('reaches no step before the plan exists', () => {
    // Prefix holding only run.created (seq 1): a run, but no plan/log/approval yet.
    expect(highestReached(viewAt(1))).toBe(-1);
  });

  it('climbs monotonically as the recording plays — never regressing', () => {
    let previous = -1;
    for (let k = 1; k <= events.length; k++) {
      const reached = highestReached(viewAt(k));
      expect(reached).toBeGreaterThanOrEqual(previous);
      previous = reached;
    }
  });

  it('latches every step in narrative order and lands on the report by the end', () => {
    // First prefix length at which each step index is reached.
    const firstReachedAt = TOUR_STEPS.map((_step, index) => {
      for (let k = 1; k <= events.length; k++) {
        if (highestReached(viewAt(k)) >= index) return k;
      }
      return Infinity;
    });

    // Every step is reached...
    for (const at of firstReachedAt) expect(at).toBeLessThan(Infinity);
    // ...and strictly in order: plan < log < approval < check < diagnosis < report.
    for (let i = 1; i < firstReachedAt.length; i++) {
      expect(firstReachedAt[i]!).toBeGreaterThan(firstReachedAt[i - 1]!);
    }

    const finalView = viewAt(events.length);
    expect(highestReached(finalView)).toBe(TOUR_STEPS.length - 1);
    // The final step is anchored on the report artifact, the run's deliverable.
    expect(TOUR_STEPS[TOUR_STEPS.length - 1]!.id).toBe('report');
  });
});
