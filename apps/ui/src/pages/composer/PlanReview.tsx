// Plan review (BIBLE §7.2): the plan rendered in place — numbered plain-language
// steps with per-step risk badge and hardware-action marker, the risk summary line,
// the degraded-bench warning repeated at approval, and the D12 connection checklist
// as a confirm-each-line list gating Approve Plan. Approve is primary; Edit task is
// secondary and returns to the composer.
import { useId, useState } from 'react';
import type { PlanStep } from '@boardex/contract';
import { Badge, Button } from '../../design';
import { DegradedBenchWarning } from './BenchReadiness';
import type { OfflineDevice } from './benchDevices';

export interface PlanReviewProps {
  plan: readonly PlanStep[];
  riskSummary: string | null;
  /** BoardProfile.connectionChecklist (D12); empty = no gate. */
  checklist: readonly { label: string; detail: string }[];
  /** Offline/error bench devices — the degraded warning repeats here (§7.2). */
  degradedDevices: readonly OfflineDevice[];
  approving: boolean;
  approveError?: string | null;
  onApprove: () => void;
  onEditTask: () => void;
}

export function PlanReview({
  plan,
  riskSummary,
  checklist,
  degradedDevices,
  approving,
  approveError,
  onApprove,
  onEditTask,
}: PlanReviewProps) {
  const checklistId = useId();
  const [confirmed, setConfirmed] = useState<ReadonlySet<number>>(new Set());
  const allConfirmed = checklist.every((_, index) => confirmed.has(index));

  const toggle = (index: number) => {
    setConfirmed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  return (
    <section aria-label="Run plan" className="rounded-card border border-border bg-bg-panel p-6 shadow-subtle">
      <h2 className="text-section font-semibold text-text-primary">Plan</h2>

      <ol aria-label="Plan steps" className="mt-4 space-y-4">
        {plan.map((step, position) => (
          <li key={step.index} className="flex gap-3">
            <span className="mt-0.5 h-6 w-6 shrink-0 rounded-full bg-neutral-badge-bg text-center text-meta font-medium leading-6 text-neutral-badge">
              {position + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body font-medium text-text-primary">{step.title}</span>
                <Badge kind="risk" value={step.riskLevel} />
                {step.hardwareAction && (
                  <span className="inline-flex items-center whitespace-nowrap rounded-full bg-neutral-badge-bg px-2 py-0.5 text-meta font-medium text-neutral-badge">
                    Hardware action
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-meta text-text-secondary">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>

      {riskSummary && (
        <p className="mt-5 border-t border-border pt-4 text-body text-text-secondary">
          <span className="font-medium text-text-primary">Risk summary: </span>
          {riskSummary}
        </p>
      )}

      {degradedDevices.length > 0 && (
        <div className="mt-4">
          <DegradedBenchWarning devices={degradedDevices} />
        </div>
      )}

      {checklist.length > 0 && (
        <div className="mt-5 border-t border-border pt-4" role="group" aria-labelledby={checklistId}>
          <h3 id={checklistId} className="text-body font-medium text-text-primary">
            Confirm bench connections
          </h3>
          <p className="mt-0.5 text-meta text-text-secondary">
            Confirm each line before approving the plan.
          </p>
          <ul className="mt-3 space-y-2">
            {checklist.map((item, index) => (
              <li key={item.label}>
                <label className="flex cursor-pointer items-baseline gap-2.5">
                  <input
                    type="checkbox"
                    checked={confirmed.has(index)}
                    onChange={() => toggle(index)}
                    className="translate-y-0.5 accent-accent"
                  />
                  <span className="text-body text-text-primary">
                    <span className="font-medium">{item.label}</span>
                    <span className="text-text-secondary"> — {item.detail}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {approveError && (
        <p role="alert" className="mt-4 rounded-card border border-warn bg-warn-bg px-4 py-3 text-body text-warn">
          {approveError}
        </p>
      )}

      <div className="mt-6 flex items-center gap-3">
        <Button variant="primary" disabled={!allConfirmed || approving} onClick={onApprove}>
          {approving ? 'Approving…' : 'Approve Plan'}
        </Button>
        <Button variant="secondary" onClick={onEditTask}>
          Edit task
        </Button>
      </div>
    </section>
  );
}
