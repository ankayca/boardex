// Right rail — Approval Card at awaiting_approval (BIBLE §7.3): proposal title,
// reason, risk badge, files changed (count, expandable list), hardware actions, and
// Approve & Continue / Review Diff / Reject. Fail-closed (decisions.md 2026-07-07):
// a blocked gate renders an explicit blocked card with no Approve control in the DOM.
// Review Diff deep-links the Evidence Detail drawer's Code Diff tab (§7.4) at the
// run's latest code_diff artifact — and fail-closed the same way the evidence band's
// Open Diff is: a run with no diff artifact yet gets an inert control with a tooltip
// saying why, never a link into an empty tab.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Approval } from '@boardex/contract';
import { Badge, Button } from '../../design';
import type { ApprovalGate } from './approvalGate';

export interface ApprovalCardProps {
  gate: ApprovalGate;
  /** Deep link to the latest code_diff artifact, or null when the run has none yet. */
  diffHref: string | null;
  /** Resolve command in flight, or accepted and awaiting the approval.resolved event. */
  resolving: boolean;
  /**
   * Which resolution is in flight, so the loading verb is specific (§6.2 v2.3:
   * Approving… / Rejecting…, never a generic "Resolving…"). Null when idle.
   */
  resolvingStatus?: 'approved' | 'rejected' | null;
  resolveError: string | null;
  onResolve: (approval: Approval, status: 'approved' | 'rejected') => void;
}

// Secondary-button styling (mirrors design/Button's secondary variant) applied to a
// Link, so Review Diff is a real anchor carrying an href — same treatment as the
// evidence band's actions.
const REVIEW_DIFF_BASE =
  'inline-flex h-9 w-full items-center justify-center rounded-control border border-border-strong bg-surface px-4 text-body font-medium text-text-primary transition-colors';

const NO_DIFF_TOOLTIP = 'No code diff has been produced for this run yet.';

function ReviewDiff({ diffHref }: { diffHref: string | null }) {
  if (diffHref === null) {
    return (
      <span aria-disabled="true" title={NO_DIFF_TOOLTIP} className={`${REVIEW_DIFF_BASE} cursor-not-allowed opacity-50`}>
        Review Diff
      </span>
    );
  }
  return (
    <Link to={diffHref} className={`${REVIEW_DIFF_BASE} hover:bg-canvas`}>
      Review Diff
    </Link>
  );
}

function FilesChanged({ files }: { files: readonly string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) {
    return <p className="text-meta text-text-secondary">No files changed.</p>;
  }
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="text-meta font-medium text-accent hover:text-accent-hover"
      >
        {files.length === 1 ? '1 file changed' : `${files.length} files changed`}
      </button>
      {expanded && (
        <ul aria-label="Files changed" className="mt-1.5 space-y-1">
          {files.map((file) => (
            <li key={file} className="font-mono text-meta text-text-primary">
              {file}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ApprovalCard({
  gate,
  diffHref,
  resolving,
  resolvingStatus = null,
  resolveError,
  onResolve,
}: ApprovalCardProps) {
  if (gate.kind === 'blocked') {
    return (
      <section
        role="alert"
        aria-label="Approval blocked"
        className="rounded-card border border-warn bg-warn-bg p-5"
      >
        <h2 className="text-body font-semibold text-warn">Approval blocked</h2>
        <p className="mt-2 text-meta text-text-secondary">{gate.reason}</p>
        <p className="mt-2 text-meta text-text-secondary">
          Boardex never approves on partial context. Wait for the runner to resend the
          approval, or stop the run.
        </p>
      </section>
    );
  }

  const { approval } = gate;
  const { proposal } = approval;

  return (
    <section
      aria-label="Approval required"
      className="rounded-card border border-warn bg-surface p-5"
    >
      <h2 className="text-body font-semibold text-text-primary">Approval required</h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p className="text-body font-medium text-text-primary">{proposal.title}</p>
        <Badge kind="risk" value={proposal.riskLevel} />
      </div>
      <p className="mt-2 text-meta text-text-secondary">{proposal.reason}</p>

      <div className="mt-4 space-y-3 border-t border-border pt-4">
        <FilesChanged files={proposal.filesChanged} />
        {proposal.hardwareActions.length > 0 && (
          <div>
            <h3 className="text-meta font-medium text-text-primary">Hardware actions</h3>
            <ul aria-label="Hardware actions" className="mt-1.5 list-disc space-y-1 pl-5">
              {proposal.hardwareActions.map((action) => (
                <li key={action} className="text-meta text-text-secondary">
                  {action}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {resolveError && (
        <p role="alert" className="mt-4 rounded-card border border-warn bg-warn-bg px-3 py-2 text-meta text-warn">
          {resolveError}
        </p>
      )}

      {/* §6.2 v2.3 gate hierarchy: ONE primary (full-width, 40px gate size),
          Review Diff as the bordered secondary, and Reject demoted to a
          tertiary destructive text action — never boxed equal to Review Diff. */}
      <div className="mt-5 flex flex-col gap-2">
        <Button
          variant="primary"
          size="gate"
          className="w-full"
          disabled={resolving}
          onClick={() => onResolve(approval, 'approved')}
        >
          {resolvingStatus === 'approved' ? 'Approving…' : 'Approve & Continue'}
        </Button>
        <ReviewDiff diffHref={diffHref} />
        <Button
          variant="tertiary-danger"
          className="w-full"
          disabled={resolving}
          onClick={() => onResolve(approval, 'rejected')}
        >
          {resolvingStatus === 'rejected' ? 'Rejecting…' : 'Reject'}
        </Button>
      </div>
    </section>
  );
}
