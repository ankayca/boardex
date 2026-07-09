// Rollback affordance rules (BIBLE §7.4): the button is always visible on the
// Code Diff tab; it is enabled only while the run is non-terminal (rollback is a
// runner-side revert, and a finished run has nothing live to revert on), else
// disabled with an explanatory tooltip. MVP behavior only — no client-side
// revert exists, and the contract (§5.3) carries no rollback route yet.
import type { RunStatus } from '@boardex/contract';

const TERMINAL: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'stopped']);

export function rollbackEnabled(status: RunStatus): boolean {
  return !TERMINAL.has(status);
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
