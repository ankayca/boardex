// Timeline derivation for the workspace center zone (BIBLE §7.3): executed run steps
// in start order, iteration dividers inserted at the reducer's marker positions
// (RunView.iterations), and the plan steps not yet executed merged in as pending
// rows at their plan-index position — a skipped index renders Pending above the
// later steps that did run, never dangling below them. Pure — the only input is the
// reduced RunView (D5).
import type { PlanStep, RunStep, RunView } from '@boardex/contract';

export type TimelineItem =
  | { kind: 'iteration'; iteration: number; reason: string }
  | { kind: 'executed'; step: RunStep }
  | { kind: 'planned'; planStep: PlanStep };

export function deriveTimeline(view: RunView): TimelineItem[] {
  const items: TimelineItem[] = [];

  // Pending plan rows, in plan order: indices no run step has executed in any
  // iteration. A plan index is "executed" the moment any run step carries it —
  // §7.3's plan is coarser than the step list (e.g. "Build & flash" covers both the
  // build and the flash run steps), and an iteration-2 re-execution of an index adds
  // a second executed row rather than reviving a pending one.
  const executedPlanIndexes = new Set(view.steps.map((step) => step.planIndex));
  const pending = (view.run.plan ?? []).filter(
    (planStep) => !executedPlanIndexes.has(planStep.index),
  );
  let nextPending = 0;
  let nextMarker = 0;

  // Emit the pending rows whose plan index precedes the given one. The cursor is
  // monotonic, so iteration 2 revisiting lower plan indices cannot re-emit a row.
  const emitPendingBelow = (planIndex: number) => {
    while (nextPending < pending.length && pending[nextPending]!.index < planIndex) {
      items.push({ kind: 'planned', planStep: pending[nextPending]! });
      nextPending += 1;
    }
  };

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
    emitPendingBelow(step.planIndex);
    emitMarkersThrough(index);
    items.push({ kind: 'executed', step });
  });
  emitMarkersThrough(view.steps.length);
  while (nextPending < pending.length) {
    items.push({ kind: 'planned', planStep: pending[nextPending]! });
    nextPending += 1;
  }

  return items;
}
