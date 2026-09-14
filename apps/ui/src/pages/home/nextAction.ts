// Next-action derivation for the Home list (BIBLE §7.1). Pure: a RunStatus maps to the
// one thing the user (or, for in-flight runs, the agent) does next — a button label and
// the route it opens — and to the attention bucket that drives ordering.
//
// The four labels the spec names verbatim (§7.1, v2.0) are "Approve plan",
// "Review approval", "View evidence", "Open report". ("Approve flash" until T5.0:
// awaiting_approval covers ANY pending approval — flash, fix, or something a real
// runner invents — and the row cannot know which, so the label now names the action
// the user actually takes rather than guessing the proposal. Product-owner ruling.) The
// in-flight states (planning/running/diagnosing/draft) have no spec label — nothing
// is *needed* from the user — so they get a neutral "View run" that opens the same
// workspace. No new routes are invented: every action targets the run workspace at
// /runs/:id (BIBLE §3 route map).
import type { RunStatus, RunSummary } from '@boardex/contract';

/** Ordering bucket (§7.1: "needs-attention first, then active, then recent"). */
export type RunAttention = 'needs-attention' | 'active' | 'recent';

export interface NextAction {
  label: string;
  route: string;
}

// A human must act only at the two amber states (§6.1/D14): plan_ready and
// awaiting_approval. Terminal states are recent; everything else is active.
export function runAttention(status: RunStatus): RunAttention {
  switch (status) {
    case 'plan_ready':
    case 'awaiting_approval':
      return 'needs-attention';
    case 'completed':
    case 'failed':
    case 'stopped':
      return 'recent';
    default:
      return 'active';
  }
}

const LABELS: Record<RunStatus, string> = {
  draft: 'View run',
  planning: 'View run',
  running: 'View run',
  diagnosing: 'View run',
  plan_ready: 'Approve plan',
  awaiting_approval: 'Review approval',
  completed: 'Open report',
  failed: 'View evidence',
  stopped: 'View evidence',
};

export function nextAction(status: RunStatus, runId: string): NextAction {
  return { label: LABELS[status], route: `/runs/${runId}` };
}

const ATTENTION_RANK: Record<RunAttention, number> = {
  'needs-attention': 0,
  active: 1,
  recent: 2,
};

// Needs-attention first, then active, then recent; within a bucket, most-recently
// updated first (§7.1). Total order, stable enough for Array.prototype.sort.
export function compareRunSummaries(a: RunSummary, b: RunSummary): number {
  const rank = ATTENTION_RANK[runAttention(a.status)] - ATTENTION_RANK[runAttention(b.status)];
  if (rank !== 0) return rank;
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/** Sort a run list into display order without mutating the input. */
export function sortRunSummaries(runs: readonly RunSummary[]): RunSummary[] {
  return [...runs].sort(compareRunSummaries);
}
