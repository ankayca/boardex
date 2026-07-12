// Elapsed-time derivation for the status card (BIBLE §7.3): the timer counts from
// run.createdAt and ticks only while the run is non-terminal. A terminal run shows
// the frozen total duration to RunView.endedAt (§5.4 v1.5) — no wall clock involved,
// so it is identical live and after a reload.
//
// The terminal-status predicate moved to lib/runStatus (T5.2: the stream client
// needs it too); re-exported here so workspace consumers keep one import site.
export { TERMINAL_RUN_STATUSES, isTerminalStatus } from '../../lib/runStatus';

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Elapsed between createdAt and nowMs as "M:SS" (or "H:MM:SS" past an hour).
 * Clamped at zero for clock skew; null when either input is unparseable, so the
 * caller renders nothing rather than a wrong figure.
 */
export function elapsedLabel(createdAt: string, nowMs: number): string | null {
  const startedMs = Date.parse(createdAt);
  if (Number.isNaN(startedMs) || !Number.isFinite(nowMs)) return null;
  const totalSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
