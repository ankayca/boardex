// The guided tour's moment model (T6.5). Pure and React-free so the anchoring — which
// step a given reduced view has reached — is testable without a DOM. Steps are ordered
// by when they actually occur in the recorded run (plan → agent log → approval gate →
// check → diagnosis → report), and each `reached` predicate is monotonic: once the
// moment has happened in the stream it stays true, so the tour only ever advances.
import type { RunView } from '@boardex/contract';

export interface TourStep {
  id: string;
  /** Short label of the zone the moment happens in — the callout names where to look. */
  zone: string;
  title: string;
  body: string;
  /** True once this moment has occurred in the reduced view. */
  reached: (view: RunView) => boolean;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'plan',
    zone: 'Plan & Progress',
    title: 'The plan',
    body: 'Boardex turned the task into numbered, plain-language steps — each with a risk level and a marker for whether it touches hardware. Nothing runs until the plan is approved.',
    reached: (view) => view.run.plan !== undefined,
  },
  {
    id: 'log',
    zone: 'Plan & Progress',
    title: 'Watch it work',
    body: 'Build, flash, and serial output stream live as the agent runs the active step — you can watch it reason and see exactly what it did, line by line.',
    reached: (view) => view.logsByStep.size > 0,
  },
  {
    id: 'approval',
    zone: 'Status & Approval',
    title: 'The approval gate',
    body: 'The agent cannot touch hardware past this line without you. Flashing, power, and resets each stop here for a human yes — the safety guarantee at the core of Boardex.',
    reached: (view) => view.approvals.length > 0,
  },
  {
    id: 'check',
    zone: 'Evidence',
    title: 'Every claim links to proof',
    body: 'Each measurement lands as a check with a verdict in the evidence band. Click a chip to open the exact logic capture, protocol decode, or log the verdict came from.',
    reached: (view) => view.checks.length > 0,
  },
  {
    id: 'diagnosis',
    zone: 'Status & Approval',
    title: 'When a check fails',
    body: 'A failed check becomes a diagnosis — ranked hypotheses with evidence links, then a proposed fix. The fix is itself an approval gate before the agent re-flashes and retries.',
    reached: (view) => view.diagnosis !== undefined,
  },
  {
    id: 'report',
    zone: 'Evidence',
    title: 'The deliverable',
    body: 'On success Boardex writes a validation report — objective, procedure, measured results, root cause, and code changes — the artifact a firmware engineer attaches to a pull request.',
    reached: (view) => view.artifacts.some((artifact) => artifact.kind === 'report_md'),
  },
];

// The index of the highest tour step the view has reached, or -1 when none has yet.
// Steps are monotonic and ordered by occurrence, so this only ever climbs.
export function highestReached(view: RunView | null): number {
  if (!view) return -1;
  let reached = -1;
  for (let i = 0; i < TOUR_STEPS.length; i++) {
    if (TOUR_STEPS[i]!.reached(view)) reached = i;
  }
  return reached;
}

// The step the callout should show: the furthest of what the user has manually
// advanced to (Next) and what the run has reached on its own (the moment occurring),
// clamped to the last step.
export function activeTourIndex(manualIndex: number, view: RunView | null): number {
  const byMoment = highestReached(view);
  return Math.min(TOUR_STEPS.length - 1, Math.max(manualIndex, byMoment));
}
