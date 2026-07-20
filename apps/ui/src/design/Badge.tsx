import type { CheckVerdict, RiskLevel, RunStatus } from '@boardex/contract';
import { AttentionGlyph, CheckGlyph, CrossGlyph, DashGlyph } from './glyphs';

/**
 * The §6.2 v2.3 badge system — every status chip belongs to exactly one class:
 *
 * 1. run-state  (kind "status")  — capsule, 22px, the 11px label step. The run
 *    machine only; colors per the D14 derivation (decisions 2026-07-07).
 * 2. risk       (kind "risk")    — capsule, 20px, the 11px label step. LOW is a
 *    FILLED neutral capsule with dark text — it must never read disabled.
 * 3. verdict    (kind "verdict") — icon-led, 24px, 12px/600 mixed case. The
 *    icon is ALWAYS present: color is never the only signal. "Not recorded"
 *    is neutral gray with a hollow dash — absence of evidence is not failure.
 * 4. inline step status — not this component: StepStatusIcon + neutral meta
 *    text in the timeline (green lives in the check icon, not the word).
 */

const riskClasses: Record<RiskLevel, string> = {
  low: 'bg-neutral-badge-bg text-neutral-badge',
  medium: 'bg-warn-bg text-warn',
  // High keeps dark text on the amber fill: white fails small-text contrast.
  high: 'bg-warn text-text-primary',
  critical: 'bg-fail text-white',
};

const riskLabels: Record<RiskLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/** Verdict values: the contract's CheckVerdict plus the UI-derived "a registered
 * check that was never recorded" state (§6.2 v2.3 — presentation-only). */
export type VerdictValue = CheckVerdict | 'not_recorded';

const verdictClasses: Record<VerdictValue, string> = {
  pass: 'bg-pass-bg text-pass',
  fail: 'bg-fail-bg text-fail',
  needs_review: 'bg-warn-bg text-warn',
  not_recorded: 'bg-neutral-badge-bg text-neutral-badge',
};

const verdictLabels: Record<VerdictValue, string> = {
  pass: 'Pass',
  fail: 'Fail',
  needs_review: 'Needs review',
  not_recorded: 'Not recorded',
};

function VerdictIcon({ value }: { value: VerdictValue }) {
  return (
    <svg viewBox="0 0 14 14" width={12} height={12} aria-hidden="true" data-verdict-icon={value}>
      {value === 'pass' && <CheckGlyph />}
      {value === 'fail' && <CrossGlyph />}
      {value === 'needs_review' && <AttentionGlyph />}
      {value === 'not_recorded' && <DashGlyph />}
    </svg>
  );
}

// Status colors derive from the D14 reservation, no new colors: green only for the
// success terminal, red only for fail/stop terminals, amber only for states where a
// human action exists (exactly plan_ready and awaiting_approval), neutral for
// everything else — diagnosing included, since the agent, not the human, acts there.
const statusClasses: Record<RunStatus, string> = {
  draft: 'bg-neutral-badge-bg text-neutral-badge',
  planning: 'bg-neutral-badge-bg text-neutral-badge',
  plan_ready: 'bg-warn-bg text-warn',
  running: 'bg-neutral-badge-bg text-neutral-badge',
  awaiting_approval: 'bg-warn-bg text-warn',
  diagnosing: 'bg-neutral-badge-bg text-neutral-badge',
  completed: 'bg-pass-bg text-pass',
  failed: 'bg-fail-bg text-fail',
  stopped: 'bg-fail-bg text-fail',
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  draft: 'Draft',
  planning: 'Planning',
  plan_ready: 'Plan ready',
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  diagnosing: 'Diagnosing',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
};

const BASE = 'inline-flex items-center whitespace-nowrap rounded-full transition-colors duration-medium ease-motion';

// The 11px label step lives ONLY in the two machine capsules (the 12px floor
// applies everywhere else); the case transform is CSS-only — labels stay
// readable text for tests and screen readers.
const CAPSULE = 'text-label font-semibold uppercase px-2';

export type BadgeProps =
  | { kind: 'risk'; value: RiskLevel }
  | { kind: 'verdict'; value: VerdictValue }
  | { kind: 'status'; value: RunStatus };

export function Badge(props: BadgeProps) {
  if (props.kind === 'verdict') {
    return (
      <span
        data-kind="verdict"
        data-value={props.value}
        className={`${BASE} h-6 gap-1 px-2 text-metadata font-semibold ${verdictClasses[props.value]}`}
      >
        <VerdictIcon value={props.value} />
        {verdictLabels[props.value]}
      </span>
    );
  }
  if (props.kind === 'risk') {
    return (
      <span
        data-kind="risk"
        data-value={props.value}
        className={`${BASE} h-5 ${CAPSULE} ${riskClasses[props.value]}`}
      >
        {riskLabels[props.value]}
      </span>
    );
  }
  return (
    <span
      data-kind="status"
      data-value={props.value}
      className={`${BASE} h-[22px] ${CAPSULE} ${statusClasses[props.value]}`}
    >
      {RUN_STATUS_LABELS[props.value]}
    </span>
  );
}
