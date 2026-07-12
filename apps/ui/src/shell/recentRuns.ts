import type { RunSummary } from '@boardex/contract';

const RECENT_COUNT = 5;

/**
 * The sidebar's Recent section (T6.1b): most recently updated first — plain
 * recency, not Home's attention-first ordering. Pure and separate from the
 * component so it stays testable and fast-refresh-safe.
 */
export function recentRuns(runs: readonly RunSummary[]): RunSummary[] {
  return [...runs]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, RECENT_COUNT);
}
