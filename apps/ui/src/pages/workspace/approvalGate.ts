// Fail-closed gate for every approval surface (decisions.md 2026-07-07): an Approve
// control renders only on full, well-formed proposal context. Missing, malformed, or
// ambiguous context blocks approval explicitly — it is never treated as an empty or
// default value. The runtime re-parse looks redundant over typed RunView data, but
// this surface must hold when a real runner (T5.3) feeds it, not just the mock.
import { ApprovalSchema, type Approval, type RunView } from '@boardex/contract';

export type ApprovalGate =
  | { kind: 'ready'; approval: Approval }
  | { kind: 'blocked'; reason: string };

const blocked = (reason: string): ApprovalGate => ({ kind: 'blocked', reason });

/** Resolve the pending approval a run paused on. Call only at awaiting_approval. */
export function deriveApprovalGate(view: RunView): ApprovalGate {
  const pending = view.approvals.filter((approval) => approval.status === 'pending');
  const [candidate] = pending;
  if (!candidate) {
    return blocked('The run is awaiting approval, but no pending approval has arrived in view.');
  }
  if (pending.length > 1) {
    return blocked('More than one approval is pending — the approval context is ambiguous.');
  }
  const parsed = ApprovalSchema.safeParse(candidate);
  if (!parsed.success) {
    return blocked('The pending approval is malformed and cannot be reviewed.');
  }
  const { title, reason } = parsed.data.proposal;
  if (title.trim() === '' || reason.trim() === '') {
    return blocked('The pending approval is missing its proposal title or reason.');
  }
  return { kind: 'ready', approval: parsed.data };
}
