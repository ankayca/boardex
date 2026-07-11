// Rollback affordance rules (BIBLE §7.4): the button is always visible on the
// Code Diff tab; it is enabled only while the run is non-terminal (rollback is a
// runner-side revert, and a finished run has nothing live to revert on), else
// disabled with an explanatory tooltip. MVP behavior only — no client-side
// revert exists, and the contract (§5.3) carries no rollback route yet.
import type { RunStatus } from '@boardex/contract';

// Exhaustive over RunStatus (same pattern as the Home list's nextAction): a
// status added to the contract fails the typecheck here instead of silently
// defaulting to enabled or disabled.
const ROLLBACK_ENABLED: Record<RunStatus, boolean> = {
  draft: true,
  planning: true,
  plan_ready: true,
  running: true,
  awaiting_approval: true,
  diagnosing: true,
  completed: false,
  failed: false,
  stopped: false,
};

export function rollbackEnabled(status: RunStatus): boolean {
  return ROLLBACK_ENABLED[status];
}

// The disabled tooltip names why (§7.4: "disabled with tooltip").
export function rollbackTooltip(status: RunStatus): string {
  return rollbackEnabled(status)
    ? 'Instructs the runner to revert this change on the target working tree.'
    : `This run is ${status} — rollback is only available while a run is active.`;
}

// What clicking the enabled button surfaces in MVP: rollback is performed by
// the runner, and no runner-side rollback command exists in the contract yet.
export const ROLLBACK_MVP_NOTICE =
  'Rollback is performed by the runner as a revert of this change. The runner-side rollback command is not part of the MVP contract yet.';
