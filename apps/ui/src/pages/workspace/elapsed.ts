// Elapsed-time derivation for the status card (BIBLE §7.3): the timer counts from
// run.createdAt and ticks only while the run is non-terminal. RunView carries no
// end timestamp for terminal runs, so a terminal run shows no elapsed figure at all —
// wall-clock-derived elapsed on a reloaded terminal run would be silently wrong.
import type { RunStatus } from '@boardex/contract';

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'completed',
  'failed',
  'stopped',
]);

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Elapsed between createdAt and nowMs as "M:SS" (or "H:MM:SS" past an hour).
 * Clamped at zero for clock skew; null when createdAt is unparseable, so the
 * caller renders nothing rather than a wrong figure.
 */
export function elapsedLabel(createdAt: string, nowMs: number): string | null {
  const startedMs = Date.parse(createdAt);
  if (Number.isNaN(startedMs)) return null;
  const totalSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
