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

/** Lines belonging to one stream, in arrival order. */
export function linesForStream(logs: readonly StepLogLine[], stream: StepLogStream): string[] {
  return logs.filter((log) => log.stream === stream).map((log) => log.line);
}
