// Plan review (BIBLE §7.2): the plan rendered in place — numbered plain-language
// steps with per-step risk badge and hardware-action marker, the risk summary line,
// the bench warning repeated at approval, and the D12 connection checklist as a
// confirm-each-line list gating Approve Plan. Approve is primary; Edit task is
// secondary and returns to the composer.
//
// The bench warning sits immediately above the checklist, not off with the plan: the
// operator confirms wiring with the bench state in view, so "SDA — PB9, confirmed"
// and "the analyzer is offline" are read in one glance rather than one scroll apart.
import { useId, useState } from 'react';
import type { PlanStep } from '@boardex/contract';
import { Badge, Button } from '../../design';
import type { BenchIssue } from '../../lib/benchReadiness';
import { BenchWarning } from './BenchReadiness';
import { approvePlanLabel, checklistProgressLine } from './planGate';

export interface PlanReviewProps {
  plan: readonly PlanStep[];
  riskSummary: string | null;
  /** BoardProfile.connectionChecklist (D12); empty on a RESOLVED profile = no gate. */
  checklist: readonly { label: string; detail: string }[];
  /**
   * Fail-closed (decisions.md 2026-07-07): Approve only ungates when the run's board
   * profile actually resolved. An empty checklist from a missing/unloaded profile must
   * never read as "nothing to confirm" — the vacuous-true bypass dies here even if a
   * caller renders this component without resolving the profile first.
   */
  profileResolved: boolean;
  /** Degraded devices and unmatched profile references — the warning repeats here (§7.2). */
  issues: readonly BenchIssue[];
  approving: boolean;
  approveError?: string | null;
  onApprove: () => void;
  onEditTask: () => void;
}

export function PlanReview({
  plan,
  riskSummary,
  checklist,
  profileResolved,
  issues,
  approving,
  approveError,
  onApprove,
  onEditTask,
}: PlanReviewProps) {
  const checklistId = useId();
  const [confirmed, setConfirmed] = useState<ReadonlySet<number>>(new Set());
  const allConfirmed = checklist.every((_, index) => confirmed.has(index));
  const approvable = profileResolved && allConfirmed;

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
    <section aria-label="Run plan" className="rounded-card border border-border bg-surface p-6">
      <h2 className="text-body font-semibold text-text-primary">Plan</h2>

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
        // Quiet neutral surface; the narrow amber rail appears ONLY when a
        // medium-or-higher-risk action exists (§7.2 v2.3) — amber stays a
        // warning, never card decoration.
        <div
          className={`mt-5 rounded-card bg-canvas px-4 py-3 ${
            plan.some((step) => step.riskLevel !== 'low')
              ? 'border-l-[3px] border-warn'
              : ''
          }`}
        >
          <p className="text-body text-text-secondary">
            <span className="font-medium text-text-primary">Risk summary: </span>
            {riskSummary}
          </p>
        </div>
      )}

      {issues.length > 0 && (
        <div className="mt-4">
          <BenchWarning issues={issues} />
        </div>
      )}

      {checklist.length > 0 && (
        <div className="mt-5 border-t border-border pt-4" role="group" aria-labelledby={checklistId}>
          <h3 id={checklistId} className="text-body font-medium text-text-primary">
            Confirm bench connections
          </h3>
          {/* The visible safety gate (Sprint 7 P0): live progress above the
              checklist — the operator always knows how far the gate is open. */}
          <p aria-live="polite" className="mt-0.5 text-meta text-text-secondary">
            {checklistProgressLine(confirmed.size, checklist.length)}
          </p>
          <ul className="mt-2">
            {checklist.map((item, index) => (
              <li key={item.label}>
                {/* ≥32px row hit target, 18px checkbox (§6.1 v2.3 geometry). */}
                <label className="flex min-h-8 cursor-pointer items-center gap-3 py-0.5">
                  <input
                    type="checkbox"
                    checked={confirmed.has(index)}
                    onChange={() => toggle(index)}
                    className="h-[18px] w-[18px] shrink-0 accent-accent"
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

      <div className="mt-6 flex items-center gap-4">
        <Button variant="primary" size="gate" disabled={!approvable || approving} onClick={onApprove}>
          {approving ? (
            'Approving…'
          ) : (
            <>
              {/* At completion the gate opens visibly: plain label + check icon.
                  The icon is the button's own foreground — not the semantic
                  green (D14: green is a recorded pass, not a ready CTA). */}
              {allConfirmed && checklist.length > 0 && (
                <svg
                  viewBox="0 0 14 14"
                  width={14}
                  height={14}
                  aria-hidden="true"
                  data-testid="approve-plan-check"
                >
                  <path
                    d="M2.5 7.5l3 3 6-7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              {approvePlanLabel(confirmed.size, checklist.length)}
            </>
          )}
        </Button>
        <Button variant="secondary" onClick={onEditTask}>
          Edit task
        </Button>
      </div>
    </section>
  );
}
