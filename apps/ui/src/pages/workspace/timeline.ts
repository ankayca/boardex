// Timeline derivation for the workspace center zone (BIBLE §7.3): executed run steps
// in start order, iteration dividers inserted at the reducer's marker positions
// (RunView.iterations), then the plan steps not yet executed as pending rows. Pure —
// the only input is the reduced RunView (D5).
import type { PlanStep, RunStep, RunView } from '@boardex/contract';

export type TimelineItem =
  | { kind: 'iteration'; iteration: number; reason: string }
  | { kind: 'executed'; step: RunStep }
  | { kind: 'planned'; planStep: PlanStep };

export function deriveTimeline(view: RunView): TimelineItem[] {
  const items: TimelineItem[] = [];
  let nextMarker = 0;

  // Emit every marker whose firstStepIndex we have reached; a marker whose first
  // step has not started yet surfaces after the last executed step.
  const emitMarkersThrough = (stepIndex: number) => {
    while (
      nextMarker < view.iterations.length &&
      view.iterations[nextMarker]!.firstStepIndex <= stepIndex
    ) {
      const { iteration, reason } = view.iterations[nextMarker]!;
      items.push({ kind: 'iteration', iteration, reason });
      nextMarker += 1;
    }
  };

  view.steps.forEach((step, index) => {
    emitMarkersThrough(index);
    items.push({ kind: 'executed', step });
  });
  emitMarkersThrough(view.steps.length);

  // Plan steps with no execution yet render pending. A plan index is "executed" the
  // moment any run step carries it — §7.3's plan is coarser than the step list
  // (e.g. "Build & flash" covers both the build and the flash run steps).
  const executedPlanIndexes = new Set(view.steps.map((step) => step.planIndex));
  for (const planStep of view.run.plan ?? []) {
    if (!executedPlanIndexes.has(planStep.index)) {
      items.push({ kind: 'planned', planStep });
    }
  }

  return items;
}
