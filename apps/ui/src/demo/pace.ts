// Playback pacing for the demo (T6.5). The recorded run spans ~6 minutes of
// wall-clock delayMs; the demo compresses that to a watchable ~90s and caps any single
// long gap so a slow build or capture never stalls the tour. Pure and tested; the
// playback hook just consumes the compressed schedule.

export interface PaceOptions {
  /** Target total playback duration in ms (the sum is scaled toward this). */
  targetTotalMs: number;
  /** No single gap plays longer than this (long recorded pauses are clamped). */
  capMs: number;
}

export const DEFAULT_PACE: PaceOptions = { targetTotalMs: 90_000, capMs: 2_500 };

// Scale every recorded delay by (target / recorded-total), then clamp to capMs. Capping
// pulls the real total a little under target — "~90s", with long gaps tamed — which is
// exactly the intent. A zero-delay burst (sub-step log lines) stays near-instant.
export function compressDelays(
  delays: readonly number[],
  options: PaceOptions = DEFAULT_PACE,
): number[] {
  const recordedTotal = delays.reduce((sum, d) => sum + Math.max(0, d), 0);
  const scale = recordedTotal > 0 ? options.targetTotalMs / recordedTotal : 0;
  return delays.map((d) => Math.min(options.capMs, Math.round(Math.max(0, d) * scale)));
}
