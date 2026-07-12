// Terminal run statuses (BIBLE §5.7): the transition graph's absorbing states.
// A terminal run's event log is complete — nothing further can ever arrive — so
// under event sourcing (D5) the run renders entirely from HTTP replay; the stream
// client uses this to decide that no WebSocket is needed (§8 T5.2).
import type { RunStatus } from '@boardex/contract';

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'completed',
  'failed',
  'stopped',
]);

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}
