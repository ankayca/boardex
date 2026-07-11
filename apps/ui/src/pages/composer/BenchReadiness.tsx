// Inline bench readiness for the composer (BIBLE §7.2): a compact device list from
// runner.status, and — when the bench reports a device unhealthy, or the selected
// profile names an instrument the bench does not have — the amber warning listing
// each one with its state-specific sentence. Composing stays allowed; the same
// warning is repeated at approval time (PlanReview renders BenchWarning again).
import type { BenchStatus, BoardProfile } from '@boardex/contract';
import { StatusDot } from '../../design';
import { benchIssues, benchIssuesTitle, type BenchIssue } from '../../lib/benchReadiness';

// Amber per D14: a warning that needs the user's attention, never decorative. Inside
// it a matched-but-unhealthy device keeps StatusDot's own semantics (amber offline,
// red error) because that dot reports the DEVICE's state; a reference nothing answers
// to has no device and so no dot — just the amber sentence.
export function BenchWarning({ issues }: { issues: readonly BenchIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div role="status" className="rounded-card border border-warn bg-warn-bg px-4 py-3">
      <p className="text-body font-medium text-warn">{benchIssuesTitle(issues)}</p>
      <ul className="mt-1 space-y-0.5">
        {issues.map((issue) => (
          <li key={issue.key}>
            {issue.status === 'degraded' ? (
              <StatusDot state={issue.deviceState} label={issue.message} />
            ) : (
              <span className="text-meta text-warn">{issue.message}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-meta text-text-secondary">
        You can still compose and plan; steps that need these instruments may fail.
      </p>
    </div>
  );
}

export interface BenchReadinessProps {
  bench: BenchStatus | null;
  /** The selected profile's instruments; null before one resolves (no claim to miss). */
  instruments: BoardProfile['instruments'] | null;
}

export function BenchReadiness({ bench, instruments }: BenchReadinessProps) {
  if (!bench) {
    return <p className="text-meta text-text-secondary">Bench status unavailable.</p>;
  }
  return (
    <div className="space-y-3">
      <ul aria-label="Bench readiness" className="flex flex-wrap items-center gap-x-5 gap-y-1">
        {bench.devices.map((device) => (
          <li key={device.id}>
            <StatusDot state={device.state} label={device.name} />
          </li>
        ))}
      </ul>
      <BenchWarning issues={benchIssues(bench, instruments)} />
    </div>
  );
}
