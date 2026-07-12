// Stream routing for the per-step log tabs (BIBLE §7.3): the five step.log streams
// of §5.2 and the pure line filter each tab pane reads through.
import type { StepLogLine, StepLogStream } from '@boardex/contract';

export const LOG_STREAMS: readonly StepLogStream[] = ['agent', 'build', 'flash', 'serial', 'rtt'];

export const STREAM_LABELS: Record<StepLogStream, string> = {
  agent: 'Agent',
  build: 'Build',
  flash: 'Flash',
  serial: 'Serial',
  rtt: 'RTT',
};

/**
 * One pass over a step's log: entries per stream, each in arrival order. Entries
 * keep their ts (T6.2) so the LogViewer can offer the optional timestamp column;
 * StepLogTabs splits the active stream's entries back into parallel line/ts arrays.
 */
export function groupLogsByStream(
  logs: readonly StepLogLine[],
): Map<StepLogStream, StepLogLine[]> {
  const grouped = new Map<StepLogStream, StepLogLine[]>();
  for (const entry of logs) {
    const entries = grouped.get(entry.stream);
    if (entries) {
      entries.push(entry);
    } else {
      grouped.set(entry.stream, [entry]);
    }
  }
  return grouped;
}

/**
 * The time-of-day (HH:MM:SS) of a step.log envelope ts, read literally from the
 * ISO string rather than via Date — the runner's recorded wall clock, with no
 * timezone re-interpretation (the contract accepts naive, offset, and Z forms,
 * §4). Returns the raw string if it carries no recognizable time component.
 */
export function formatLogTime(iso: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match ? match[1]! : iso;
}
