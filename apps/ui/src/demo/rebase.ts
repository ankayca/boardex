// Timestamp rebasing for demo playback (T6.5), mirroring the mock runner's §5.6
// behaviour: a recorded run's authored timestamps are shifted so run.created lands at
// playback start, preserving every inter-event delta. Without this the status card's
// elapsed — now minus run.createdAt — reads days, since the fixture is authored-time.
// The event stream stays contract-valid; only the wall-clock origin moves.
import { parseWireEvent, type WireEvent } from '@boardex/contract';
import type { DemoEntry } from './data/demoRun';

// A string that IS an ISO 8601 datetime, entire — log lines and values that merely
// contain digits never match, so only real timestamps shift. (Same rule as the mock.)
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

// Deep-shift every ISO timestamp in a value — the envelope ts AND payload ones
// (run.createdAt/updatedAt, approval resolvedAt, artifact createdAt, …). Elapsed reads
// payload.run.createdAt, so shifting the envelope alone would lie.
function shiftTimestamps(value: unknown, offsetMs: number): unknown {
  if (typeof value === 'string' && ISO_DATETIME.test(value)) {
    return new Date(Date.parse(value) + offsetMs).toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => shiftTimestamps(item, offsetMs));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, shiftTimestamps(entry, offsetMs)]),
    );
  }
  return value;
}

// Rebase a whole recorded run so its first event lands at nowMs, keeping deltas. Each
// shifted event is re-validated through the contract parser — a rebased stream is still
// a legal §5.2 stream.
export function rebaseEntries(entries: readonly DemoEntry[], nowMs: number): DemoEntry[] {
  const firstTs = entries[0] ? Date.parse(entries[0].event.ts) : NaN;
  const offsetMs = Number.isFinite(firstTs) ? nowMs - firstTs : 0;
  return entries.map((entry) => {
    const shifted = parseWireEvent(shiftTimestamps(entry.event, offsetMs));
    if (!shifted) throw new Error('rebased demo event failed to re-validate');
    return { delayMs: entry.delayMs, event: shifted as WireEvent };
  });
}
