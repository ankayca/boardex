// Right rail — current status card (BIBLE §7.3): status badge, elapsed since
// run.createdAt (ticking while non-terminal; frozen at RunView.endedAt once
// terminal, §5.4 v1.5 — reload-stable, no wall clock), the run's contract
// warnings (RunView.warnings, T5.0/F5 — a compact amber line expanding to the
// list; amber because a warning needs the human, D14), and Stop Run — danger,
// always visible while the run is non-terminal, behind a ConfirmDialog.
import { useEffect, useState } from 'react';
import type { Run } from '@boardex/contract';
import { Badge, Button, ConfirmDialog } from '../../design';
import { elapsedLabel, isTerminalStatus } from './elapsed';

export interface StatusCardProps {
  run: Run;
  /** RunView.endedAt — the terminal event's envelope ts; undefined while non-terminal. */
  endedAt: string | undefined;
  /** RunView.warnings — contract violations the reducer observed. */
  warnings: readonly string[];
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

export function StatusCard({ run, endedAt, warnings, stopping, stopError, onStop }: StatusCardProps) {
  const terminal = isTerminalStatus(run.status);
  const now = useNow(!terminal);
  const [confirming, setConfirming] = useState(false);
  const elapsed = terminal
    ? endedAt !== undefined
      ? elapsedLabel(run.createdAt, Date.parse(endedAt))
      : null
    : elapsedLabel(run.createdAt, now);

  return (
    <section aria-label="Run status" className="rounded-card border border-border bg-bg-panel p-5 shadow-subtle">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-section font-semibold text-text-primary">Status</h2>
        <Badge kind="status" value={run.status} />
      </div>
      {elapsed && (
        <p className="mt-2 text-meta text-text-secondary">
          Elapsed <span className="font-mono text-text-primary">{elapsed}</span>
        </p>
      )}
      <ContractWarnings warnings={warnings} />
      {stopError && (
        <p role="alert" className="mt-3 rounded-card border border-warn bg-warn-bg px-3 py-2 text-meta text-warn">
          {stopError}
        </p>
      )}
      {!terminal && (
        <Button
          variant="danger"
          className="mt-4 w-full"
          disabled={stopping}
          onClick={() => setConfirming(true)}
        >
          {stopping ? 'Stopping…' : 'Stop Run'}
        </Button>
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
