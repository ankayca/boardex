// The dual-outcome derivation (Sprint 7 P0 stage 4, §7.3/§7.6 v2.4): a terminal
// run states TWO separate dimensions — what the RUN did (execution: terminal
// status + the terminal reason) and what the EVIDENCE covers (validation
// coverage: recorded check.evaluated results measured against the plan's
// declared registry). Both come purely from RunView (D5). A stream that
// declared no registry (any pre-v2.4 recording, e.g. records/bmp180-run) gets
// coverage WITHOUT a denominator — the denominator is never invented and never
// parsed from plan prose or report markdown.
import type { CheckExpectation, RunView } from '@boardex/contract';
import { isTerminalStatus } from './elapsed';

export type TerminalStatus = 'completed' | 'failed' | 'stopped';

export type Coverage =
  | {
      kind: 'registered';
      /** Registered requirements with at least one recorded check. */
      recorded: number;
      registered: number;
      /** Declared expectations never recorded — rendered neutral, NEVER red. */
      notRecorded: CheckExpectation[];
    }
  | {
      kind: 'unregistered';
      /** All recorded checks; the producer declared no registry. */
      recorded: number;
    };

export interface DualOutcome {
  execution: { status: TerminalStatus; reason: string | null };
  coverage: Coverage;
}

/** Null while the run is non-terminal — the split exists only once the run has
 * an outcome to state. */
export function deriveDualOutcome(view: RunView): DualOutcome | null {
  const status = view.run.status;
  if (!isTerminalStatus(status)) return null;

  const recordedRequirements = new Set(view.checks.map((check) => check.requirementId));
  const coverage: Coverage =
    view.registeredChecks !== undefined
      ? {
          kind: 'registered',
          recorded: view.registeredChecks.filter((expectation) =>
            recordedRequirements.has(expectation.requirementId),
          ).length,
          registered: view.registeredChecks.length,
          notRecorded: view.registeredChecks.filter(
            (expectation) => !recordedRequirements.has(expectation.requirementId),
          ),
        }
      : { kind: 'unregistered', recorded: view.checks.length };

  return {
    execution: {
      status: status as TerminalStatus,
      reason: view.terminalSummary ?? null,
    },
    coverage,
  };
}

const EXECUTION_LABELS: Record<TerminalStatus, string> = {
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
};

export function executionLabel(outcome: DualOutcome): string {
  return EXECUTION_LABELS[outcome.execution.status];
}

export function coverageLine(coverage: Coverage): string {
  if (coverage.kind === 'registered') {
    return `${coverage.recorded} of ${coverage.registered} checks recorded`;
  }
  return `${coverage.recorded} ${coverage.recorded === 1 ? 'check' : 'checks'} recorded · no check registry declared`;
}
