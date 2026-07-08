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

/** One pass over a step's log: lines per stream, each in arrival order. */
export function groupLogsByStream(logs: readonly StepLogLine[]): Map<StepLogStream, string[]> {
  const grouped = new Map<StepLogStream, string[]>();
  for (const { stream, line } of logs) {
    const lines = grouped.get(stream);
    if (lines) {
      lines.push(line);
    } else {
      grouped.set(stream, [line]);
    }
  }
  return grouped;
}
