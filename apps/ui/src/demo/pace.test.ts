import { describe, expect, it } from 'vitest';
import { compressDelays, DEFAULT_PACE } from './pace';
import { DEMO_ENTRIES } from './data/demoRun';

describe('compressDelays', () => {
  it('returns nothing for an empty schedule', () => {
    expect(compressDelays([])).toEqual([]);
  });

  it('keeps zero-delay bursts instant', () => {
    expect(compressDelays([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('clamps any single long gap to the cap', () => {
    const paced = compressDelays([10_000, 10_000], { targetTotalMs: 90_000, capMs: 2_500 });
    for (const d of paced) expect(d).toBeLessThanOrEqual(2_500);
  });

  it('scales toward the target and never exceeds it (caps only pull it lower)', () => {
    const delays = [1_000, 2_000, 3_000, 60_000];
    const paced = compressDelays(delays, DEFAULT_PACE);
    const total = paced.reduce((a, b) => a + b, 0);
    // Capping the 60s gap pulls the total under target; it must never overshoot.
    expect(total).toBeLessThanOrEqual(DEFAULT_PACE.targetTotalMs);
    for (const d of paced) expect(d).toBeLessThanOrEqual(DEFAULT_PACE.capMs);
  });

  it('compresses the real recording to a watchable span with every gap capped', () => {
    const paced = compressDelays(DEMO_ENTRIES.map((e) => e.delayMs));
    const total = paced.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(DEFAULT_PACE.targetTotalMs);
    for (const d of paced) expect(d).toBeLessThanOrEqual(DEFAULT_PACE.capMs);
  });
});
