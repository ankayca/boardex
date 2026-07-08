// Right rail — Approval Card at awaiting_approval (BIBLE §7.3): proposal title,
// reason, risk badge, files changed (count, expandable list), hardware actions, and
// Approve & Continue / Review Diff / Reject. Fail-closed (decisions.md 2026-07-07):
// a blocked gate renders an explicit blocked card with no Approve control in the DOM.
// Review Diff opens the Drawer with a placeholder — diff rendering arrives in T3.2.
import { useState } from 'react';
import type { Approval } from '@boardex/contract';
import { Badge, Button, Drawer } from '../../design';
import type { ApprovalGate } from './approvalGate';

export interface ApprovalCardProps {
  gate: ApprovalGate;
  /** Resolve command in flight, or accepted and awaiting the approval.resolved event. */
  resolving: boolean;
  resolveError: string | null;
  onResolve: (approval: Approval, status: 'approved' | 'rejected') => void;
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

export function ApprovalCard({ gate, resolving, resolveError, onResolve }: ApprovalCardProps) {
  const [diffOpen, setDiffOpen] = useState(false);

  if (gate.kind === 'blocked') {
    return (
      <section
        role="alert"
        aria-label="Approval blocked"
        className="rounded-card border border-warn bg-warn-bg p-5"
      >
        <h2 className="text-section font-semibold text-warn">Approval blocked</h2>
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
      className="rounded-card border border-warn bg-bg-panel p-5 shadow-subtle"
    >
      <h2 className="text-section font-semibold text-text-primary">Approval required</h2>
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

      <div className="mt-5 flex flex-col gap-2">
        <Button
          variant="primary"
          disabled={resolving}
          onClick={() => onResolve(approval, 'approved')}
        >
          {resolving ? 'Resolving…' : 'Approve & Continue'}
        </Button>
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={() => setDiffOpen(true)}>
            Review Diff
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            disabled={resolving}
            onClick={() => onResolve(approval, 'rejected')}
          >
            Reject
          </Button>
        </div>
      </div>

      <Drawer open={diffOpen} title="Proposed changes" onClose={() => setDiffOpen(false)}>
        <p className="text-body text-text-secondary">
          Diff rendering arrives with T3.2. This proposal touches:
        </p>
        <ul className="mt-3 space-y-1">
          {proposal.filesChanged.map((file) => (
            <li key={file} className="font-mono text-meta text-text-primary">
              {file}
            </li>
          ))}
        </ul>
      </Drawer>
    </section>
  );
}
