// Center zone — Plan & Progress (BIBLE §7.3): the task prompt collapsed to two lines
// and expandable, then the plan as a vertical timeline. Executed steps expand to
// summary, artifact chips, and the per-stream log pane; the active step is
// auto-expanded; iteration >= 2 renders a divider driven by run.iteration_started.
import { useState } from 'react';
import type { Artifact, RunStep, RunView, StepLogLine, StepStatus } from '@boardex/contract';
import { StepStatusIcon } from '../../design';
import { deriveTimeline } from './timeline';
import { StepLogTabs } from './StepLogTabs';

const statusLabels: Record<StepStatus, string> = {
  pending: 'Pending',
  active: 'Active',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
};

// Stable empty-log identity so StepLogTabs' grouping memo doesn't recompute for
// steps that have no output yet.
const NO_LOGS: readonly StepLogLine[] = [];

const statusTextClasses: Record<StepStatus, string> = {
  pending: 'text-text-secondary',
  active: 'text-accent',
  succeeded: 'text-pass',
  failed: 'text-fail',
  skipped: 'text-text-secondary',
};

// T6.1 iconography: status glyphs (StepStatusIcon) replace bare dots so the
// timeline scans by shape, not color alone — D14 mapping lives in the icon.
// The wrapping span is opaque so the glyph masks the timeline rule beneath it.
function TimelineMarker({ status }: { status: StepStatus }) {
  return (
    <span
      aria-hidden="true"
      className="absolute -left-[7px] top-1.5 inline-flex rounded-full bg-bg-app"
    >
      <StepStatusIcon status={status} />
    </span>
  );
}

function ArtifactChips({ artifacts }: { artifacts: readonly Artifact[] }) {
  if (artifacts.length === 0) return null;
  return (
    <ul aria-label="Step artifacts" className="mt-2 flex flex-wrap gap-1.5">
      {artifacts.map((artifact) => (
        <li
          key={artifact.id}
          className="rounded-full border border-border bg-bg-app px-2.5 py-0.5 text-meta text-text-secondary"
        >
          {artifact.label}
        </li>
      ))}
    </ul>
  );
}

interface ExecutedStepRowProps {
  step: RunStep;
  logs: readonly StepLogLine[];
  artifacts: readonly Artifact[];
  expanded: boolean;
  onToggle: () => void;
}

function ExecutedStepRow({ step, logs, artifacts, expanded, onToggle }: ExecutedStepRowProps) {
  return (
    <li className="relative pb-6 pl-6">
      <TimelineMarker status={step.status} />
      {/* T6.1b: the status label sits adjacent to the title (icon · title · status),
          not orphaned at the row's right edge. */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-baseline gap-2.5 text-left"
      >
        <span className="text-body font-medium text-text-primary">{step.title}</span>
        <span className={`shrink-0 text-meta font-medium ${statusTextClasses[step.status]}`}>
          {statusLabels[step.status]}
        </span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-3">
          {step.summary && <p className="text-meta text-text-secondary">{step.summary}</p>}
          <ArtifactChips artifacts={artifacts} />
          <StepLogTabs stepTitle={step.title} logs={logs} />
        </div>
      )}
    </li>
  );
}

function PlannedStepRow({ title, detail }: { title: string; detail: string }) {
  return (
    <li className="relative pb-6 pl-6">
      <TimelineMarker status="pending" />
      <div className="flex items-baseline gap-2.5">
        <span className="text-body font-medium text-text-primary">{title}</span>
        <span className="shrink-0 text-meta font-medium text-text-secondary">Pending</span>
      </div>
      <p className="mt-0.5 text-meta text-text-secondary">{detail}</p>
    </li>
  );
}

function IterationDivider({ iteration, reason }: { iteration: number; reason: string }) {
  return (
    <li aria-label={`Iteration ${iteration}`} className="relative pb-6 pl-6">
      <div className="-ml-6 flex items-center gap-3">
        <span className="whitespace-nowrap rounded-full border border-border bg-bg-app px-3 py-0.5 text-meta font-medium text-text-primary">
          Iteration {iteration} — applying fix
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </div>
      <p className="mt-1.5 text-meta text-text-secondary">{reason}</p>
    </li>
  );
}

function TaskPrompt({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-card border border-border bg-bg-panel px-5 py-4 shadow-subtle">
      <p className={`whitespace-pre-wrap text-body text-text-primary ${expanded ? '' : 'line-clamp-2'}`}>
        {prompt}
      </p>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="mt-1 text-meta font-medium text-accent hover:text-accent-hover"
      >
        {expanded ? 'Show less' : 'Show full task'}
      </button>
    </div>
  );
}

export function PlanTimeline({ view }: { view: RunView }) {
  // Expansion overrides by step id; without one, exactly the active step is open.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const items = deriveTimeline(view);
  const artifactsById = new Map(view.artifacts.map((artifact) => [artifact.id, artifact]));

  const toggle = (step: RunStep, expanded: boolean) => {
    setOverrides((prev) => new Map(prev).set(step.id, !expanded));
  };

  return (
    <section aria-label="Plan and progress" className="min-w-0">
      <TaskPrompt prompt={view.run.taskPrompt} />
      {items.length === 0 ? (
        <p className="mt-6 text-body text-text-secondary">Waiting for the plan…</p>
      ) : (
        <ol aria-label="Run timeline" className="mt-6 border-l-2 border-border pl-0 [list-style:none]">
          {items.map((item) => {
            if (item.kind === 'iteration') {
              return (
                <IterationDivider
                  key={`iteration-${item.iteration}`}
                  iteration={item.iteration}
                  reason={item.reason}
                />
              );
            }
            if (item.kind === 'planned') {
              return (
                <PlannedStepRow
                  key={`planned-${item.planStep.index}`}
                  title={item.planStep.title}
                  detail={item.planStep.detail}
                />
              );
            }
            const { step } = item;
            const expanded = overrides.get(step.id) ?? step.status === 'active';
            return (
              <ExecutedStepRow
                key={step.id}
                step={step}
                logs={view.logsByStep.get(step.id) ?? NO_LOGS}
                artifacts={step.artifactIds
                  .map((id) => artifactsById.get(id))
                  .filter((artifact): artifact is Artifact => artifact !== undefined)}
                expanded={expanded}
                onToggle={() => toggle(step, expanded)}
              />
            );
          })}
        </ol>
      )}
    </section>
  );
}
