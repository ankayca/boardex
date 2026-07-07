import type { CheckVerdict, RiskLevel, RunStatus } from '@boardex/contract';

// BIBLE §6.2, exact: risk low = neutral, medium = amber outline, high = amber solid,
// critical = red solid. Verdict: pass = green, fail = red, needs_review = amber.
// text-white on solid fills is the §6.1 panel white (#FFFFFF).
const riskClasses: Record<RiskLevel, string> = {
  low: 'bg-neutral-badge-bg text-neutral-badge',
  medium: 'border border-warn text-warn',
  high: 'bg-warn text-white',
  critical: 'bg-fail text-white',
};

const riskLabels: Record<RiskLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const verdictClasses: Record<CheckVerdict, string> = {
  pass: 'bg-pass-bg text-pass',
  fail: 'bg-fail-bg text-fail',
  needs_review: 'bg-warn-bg text-warn',
};

const verdictLabels: Record<CheckVerdict, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  needs_review: 'NEEDS REVIEW',
};

// Status colors derive from the D14 reservation, no new colors: green only for the
// success terminal, red only for fail/stop terminals, amber only for states that
// need the human (approval or a diagnosed failure), neutral for everything else.
const statusClasses: Record<RunStatus, string> = {
  draft: 'bg-neutral-badge-bg text-neutral-badge',
  planning: 'bg-neutral-badge-bg text-neutral-badge',
  plan_ready: 'bg-warn-bg text-warn',
  running: 'bg-neutral-badge-bg text-neutral-badge',
  awaiting_approval: 'bg-warn-bg text-warn',
  diagnosing: 'bg-warn-bg text-warn',
  completed: 'bg-pass-bg text-pass',
  failed: 'bg-fail-bg text-fail',
  stopped: 'bg-fail-bg text-fail',
};

const statusLabels: Record<RunStatus, string> = {
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

export type BadgeProps =
  | { kind: 'risk'; value: RiskLevel }
  | { kind: 'verdict'; value: CheckVerdict }
  | { kind: 'status'; value: RunStatus };

export function Badge(props: BadgeProps) {
  const { classes, label } =
    props.kind === 'risk'
      ? { classes: riskClasses[props.value], label: riskLabels[props.value] }
      : props.kind === 'verdict'
        ? { classes: verdictClasses[props.value], label: verdictLabels[props.value] }
        : { classes: statusClasses[props.value], label: statusLabels[props.value] };

  return (
    <span
      data-kind={props.kind}
      data-value={props.value}
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-meta font-medium ${classes}`}
    >
      {label}
    </span>
  );
}
