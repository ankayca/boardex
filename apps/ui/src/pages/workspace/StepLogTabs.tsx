// Per-stream log tabs for one timeline step (BIBLE §7.3): the five step.log streams
// from §5.2, each routed to its own LogViewer pane fed by RunView.logsByStep.
import { useId, useMemo, useState } from 'react';
import type { StepLogLine, StepLogStream } from '@boardex/contract';
import { LogViewer } from '../../design';
import { groupLogsByStream, LOG_STREAMS, STREAM_LABELS } from './logStreams';

export interface StepLogTabsProps {
  stepTitle: string;
  logs: readonly StepLogLine[];
}

export function StepLogTabs({ stepTitle, logs }: StepLogTabsProps) {
  const grouped = useMemo(() => groupLogsByStream(logs), [logs]);
  // Initial tab: the first stream with output (agent when the pane opens empty).
  // Only the user switches after that — no effect re-picks as new streams arrive.
  const [active, setActive] = useState<StepLogStream>(
    () => LOG_STREAMS.find((stream) => grouped.has(stream)) ?? 'agent',
  );
  const baseId = useId();
  const activeLines = grouped.get(active) ?? [];

  return (
    <div>
      <div role="tablist" aria-label={`${stepTitle} log streams`} className="flex gap-1">
        {LOG_STREAMS.map((stream) => {
          const count = grouped.get(stream)?.length ?? 0;
          const selected = stream === active;
          return (
            <button
              key={stream}
              type="button"
              role="tab"
              id={`${baseId}-tab-${stream}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${stream}`}
              onClick={() => setActive(stream)}
              className={`rounded-t-lg border border-b-0 px-3 py-1.5 text-meta font-medium ${
                selected
                  ? 'border-border bg-bg-panel text-text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {STREAM_LABELS[stream]}
              {count > 0 && <span className="ml-1.5 text-text-secondary">{count}</span>}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-${active}`}
        aria-labelledby={`${baseId}-tab-${active}`}
      >
        <LogViewer
          lines={activeLines}
          maxHeightPx={320}
          label={`${stepTitle} — ${STREAM_LABELS[active]} log`}
        />
      </div>
    </div>
  );
}
