// Compact report-header metadata row (BIBLE §7.6, Sprint 7 P1 #9): the scannable
// "Run ID · date · iterations" strip above the dual-outcome split. Presentation
// of existing RunView data only (D5) — no new derivation, no wire read. The
// result/checks dimensions stay in the dual-outcome split below it (§7.6), where
// the terminal reason is preserved; this row is just the quick metadata.
import type { RunView } from '@boardex/contract';

export interface ReportSummary {
  runId: string;
  /** ISO date (yyyy-mm-dd) of the terminal event, or null while non-terminal. */
  date: string | null;
  /** Total iterations — 1 plus each fix-loop iteration (the highest declared). */
  iterations: number;
}

export function reportSummary(view: RunView): ReportSummary {
  const iterations = view.iterations.length
    ? Math.max(...view.iterations.map((entry) => entry.iteration))
    : 1;
  return {
    runId: view.run.id,
    // endedAt is the terminal event's ts (§5.4 v1.5); a report exists only for a
    // terminal run, so this is present in practice. Slice to the calendar date —
    // the report is a document, not a live clock.
    date: view.endedAt ? view.endedAt.slice(0, 10) : null,
    iterations,
  };
}
