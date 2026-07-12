// Right rail — current status card (BIBLE §7.3): status badge, elapsed since
// run.createdAt (ticking while non-terminal; frozen at RunView.endedAt once
// terminal, §5.4 v1.5 — reload-stable, no wall clock), the run's contract
// warnings (RunView.warnings, T5.0/F5 — a compact amber line expanding to the
// list; amber because a warning needs the human, D14), and Stop Run — danger,
// always visible while the run is non-terminal, behind a ConfirmDialog.
import { useEffect, useState } from 'react';
import type { Run } from '@boardex/contract';
import { Badge, Button, ConfirmDialog, Progress } from '../../design';
import { elapsedLabel, isTerminalStatus } from './elapsed';
import type { PlanProgress } from './progress';

export interface StatusCardProps {
  run: Run;
  /** RunView.endedAt — the terminal event's envelope ts; undefined while non-terminal. */
  endedAt: string | undefined;
  /** RunView.warnings — contract violations the reducer observed. */
  warnings: readonly string[];
  /** Plan-step completion (T6.2); rendered only when the plan has steps. */
  progress: PlanProgress;
  /** Stop command in flight, or accepted and awaiting the run.stopped event. */
  stopping: boolean;
  stopError: string | null;
  onStop: () => void;
}

// Compact by default: one amber line stating the count, expanding on demand to
// the reducer's verbatim messages. These read as "the stream broke a rule", so
// the full text is a details-on-demand affordance, not permanent rail noise.
function ContractWarnings({ warnings }: { warnings: readonly string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (warnings.length === 0) return null;
  const label =
    warnings.length === 1 ? '1 contract warning' : `${warnings.length} contract warnings`;
  return (
    <div role="status" className="mt-3 rounded-card border border-warn bg-warn-bg px-3 py-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="text-meta font-medium text-warn underline underline-offset-2 hover:no-underline"
      >
        {label}
      </button>
      {expanded && (
        <ul className="mt-1 space-y-1">
          {warnings.map((warning) => (
            <li key={warning} className="font-mono text-meta text-warn">
              {warning}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// One-second tick while active; a terminal run's duration is frozen at endedAt.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function StatusCard({
  run,
  endedAt,
  warnings,
  progress,
  stopping,
  stopError,
  onStop,
}: StatusCardProps) {
  const terminal = isTerminalStatus(run.status);
  const now = useNow(!terminal);
  const [confirming, setConfirming] = useState(false);
  const elapsed = terminal
    ? endedAt !== undefined
      ? elapsedLabel(run.createdAt, Date.parse(endedAt))
      : null
    : elapsedLabel(run.createdAt, now);
  const percent = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;

  return (
    <section aria-label="Run status" className="rounded-card border border-border bg-bg-panel p-5 shadow-subtle">
      {/* One instrument block (T6.2): status, elapsed, and plan progress read as a
          single readout, with Stop as the block's escape hatch. */}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-section font-semibold text-text-primary">Status</h2>
        <Badge kind="status" value={run.status} />
      </div>
      {elapsed && (
        <p className="mt-2 text-meta text-text-secondary">
          Elapsed <span className="font-mono text-text-primary">{elapsed}</span>
        </p>
      )}
      {/* Model attribution (T6.3/T6.6) — only when the runner echoed one onto the run. */}
      {run.model && (
        <p className="mt-1 text-meta text-text-secondary">
          Model <span className="font-mono text-text-primary">{run.model}</span>
        </p>
      )}
      {progress.total > 0 && (
        // "Verified" (not "plan progress") per the latest-execution-wins rider: the
        // count is plan steps whose latest execution succeeded — steps proven, not
        // merely attempted.
        <div className="mt-4">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-label uppercase text-text-secondary">Verified</span>
            <span className="font-mono text-meta text-text-primary">
              {progress.completed} / {progress.total}
            </span>
          </div>
          <Progress
            value={percent}
            label={`Verified: ${progress.completed} of ${progress.total} plan steps`}
          />
        </div>
      )}
      <ContractWarnings warnings={warnings} />
      {stopError && (
        <p role="alert" className="mt-3 rounded-card border border-warn bg-warn-bg px-3 py-2 text-meta text-warn">
          {stopError}
        </p>
      )}
      {!terminal && (
        // T6.1c: outline-danger at natural width, right-aligned — an ever-present
        // escape hatch, not a full-width alarm bar. Red still means stop only (D14).
        <div className="mt-4 flex justify-end">
          <Button
            variant="outline-danger"
            disabled={stopping}
            onClick={() => setConfirming(true)}
          >
            {stopping ? 'Stopping…' : 'Stop Run'}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title="Stop this run?"
        description="The run ends immediately as Stopped and cannot be resumed. Evidence collected so far is retained."
        confirmLabel="Stop Run"
        danger
        onConfirm={() => {
          setConfirming(false);
          onStop();
        }}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}
