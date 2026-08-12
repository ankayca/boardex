// Plan progress derivation for the StatusCard instrument block (BIBLE §7.3, T6.2
// item 2). Pure — the only input is the reduced RunView (D5).
//
// The plan (run.plan) is the denominator: it is what the timeline shows and what
// the user approved. Run steps are finer-grained than plan steps (one plan step,
// e.g. "Build & flash", spans several run steps) and iteration ≥2 re-executes a
// plan index, so "steps completed" can only be counted at plan-index granularity.
//
// Latest-execution-wins (product-owner ruling): a plan index counts as complete only when
// its LATEST executed step succeeded. view.steps is in start order, so a later step
// for the same plan index overwrites an earlier one — an iteration-2 re-open of a
// failed index drops it back out of the count until it re-succeeds.
import type { RunView, StepStatus } from '@boardex/contract';

export interface PlanProgress {
  completed: number;
  total: number;
}

export function deriveProgress(view: RunView): PlanProgress {
  const total = view.run.plan?.length ?? 0;
  if (total === 0) {
    return { completed: 0, total: 0 };
  }

  const latestByIndex = new Map<number, StepStatus>();
  for (const step of view.steps) {
    latestByIndex.set(step.planIndex, step.status);
  }

  let completed = 0;
  for (const [index, status] of latestByIndex) {
    // Guard against a step carrying a plan index outside the plan bounds.
    if (index >= 0 && index < total && status === 'succeeded') {
      completed += 1;
    }
  }

  return { completed, total };
}
