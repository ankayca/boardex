// Right rail — Status & Approval (BIBLE §7.3, T2.2). Owns the two run commands
// (stop, resolve approval) and their idempotency: buttons stay disabled from click
// until the confirming event lands in the reduced view, and a 409 StateConflict is
// state refresh, not an error — the event stream reconciles the view (§5.3).
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Approval, RunView } from '@boardex/contract';
import { api, StateConflict } from '../../lib/api';
import { benchIssues } from '../../lib/benchReadiness';
import { useBenchStatus } from '../../lib/useBenchStatus';
import { BenchWarning } from '../composer/BenchReadiness';
import { deriveApprovalGate } from './approvalGate';
import { ApprovalCard } from './ApprovalCard';
import { DiagnosisCard } from './DiagnosisCard';
import { evidenceHref, evidenceTargets } from './evidence';
import { deriveProgress } from './progress';
import { StatusCard } from './StatusCard';

export function StatusApprovalRail({ view }: { view: RunView }) {
  const { run } = view;
  // Review Diff targets the run's latest code_diff artifact, exactly as the evidence
  // band's Open Diff does; null when the run has produced none yet.
  const diffTarget = evidenceTargets(view).diff;

  const stop = useMutation({
    mutationFn: () => api.stopRun(run.id),
    onError: (error) => {
      if (error instanceof StateConflict) stop.reset();
    },
  });

  const resolve = useMutation({
    mutationFn: ({ approval, status }: { approval: Approval; status: 'approved' | 'rejected' }) =>
      api.resolveApproval(run.id, approval.id, status),
    onError: (error) => {
      if (error instanceof StateConflict) resolve.reset();
    },
  });

  // The completed run's deliverable (§7.6): a prominent link to the Validation
  // Report, shown only once the report_md artifact exists — a failed run that never
  // produced one renders no link, no dead end.
  const reportTarget = evidenceTargets(view).report;

  const awaiting = run.status === 'awaiting_approval';
  const gate = awaiting ? deriveApprovalGate(view) : null;
  // Exactly one approve surface per pending approval (T2.2 review F1/F3): the
  // Diagnosis Card owns the fix approval — the pending approval whose id matches the
  // reducer-derived diagnosis.fixApprovalId (§5.4 v1.6) — and the generic Approval
  // Card owns every other approval, suppressed at the fix gate. A pending approval
  // unrelated to the diagnosis never renders the Diagnosis Card.
  const fixApproval =
    gate?.kind === 'ready' &&
    view.diagnosis?.fixApprovalId !== undefined &&
    gate.approval.id === view.diagnosis.fixApprovalId
      ? gate.approval
      : null;
  const showDiagnosis =
    view.diagnosis !== undefined && (run.status === 'diagnosing' || fixApproval !== null);

  // The §7.2 bench-degraded warning repeats at every approval that proposes
  // hardware actions (Kerem's T5.0 adjudication): an operator about to authorize a
  // flash deserves the same "your analyzer is unplugged" they got at composition.
  // Profile-independent by the same ruling — mid-run approvals gate on the bench's
  // own report only (instruments: null), never on re-resolving a profile.
  const bench = useBenchStatus();
  const pendingApproval = gate?.kind === 'ready' ? gate.approval : null;
  const hardwareApprovalIssues =
    pendingApproval && pendingApproval.proposal.hardwareActions.length > 0
      ? benchIssues(bench, null)
      : [];

  // isSuccess holds the buttons disabled until the resolved/stopped event arrives;
  // the approval-id check re-arms them if a later approval reuses this mutation.
  const stopping = stop.isPending || stop.isSuccess;
  const resolvingFor = (approval: Approval): boolean =>
    resolve.isPending || (resolve.isSuccess && resolve.variables?.approval.id === approval.id);

  const commandError = (error: unknown, message: string): string | null =>
    error && !(error instanceof StateConflict) ? message : null;

  // h-full lets the sticky status card travel the full height of the (stretched)
  // rail grid area, so Stop Run stays reachable down a long timeline (T6.2b).
  return (
    <div className="h-full space-y-4">
      <div className="rail-sticky">
        <StatusCard
          run={run}
          endedAt={view.endedAt}
          warnings={view.warnings}
          progress={deriveProgress(view)}
          stopping={stopping}
          stopError={commandError(
            stop.error,
            'Could not stop the run — check that the runner is online, then try again.',
          )}
          onStop={() => stop.mutate()}
        />
      </div>
      {reportTarget && (
        <Link
          to={`/runs/${run.id}/report`}
          className="flex w-full items-center justify-center rounded-button bg-accent px-4 py-2 text-body font-medium text-white transition-colors hover:bg-accent-hover"
        >
          Open Validation Report
        </Link>
      )}
      {hardwareApprovalIssues.length > 0 && <BenchWarning issues={hardwareApprovalIssues} />}
      {gate && fixApproval === null && (
        <ApprovalCard
          gate={gate}
          diffHref={diffTarget && evidenceHref(run.id, diffTarget)}
          resolving={gate.kind === 'ready' && resolvingFor(gate.approval)}
          resolveError={commandError(
            resolve.error,
            'Could not resolve the approval — check that the runner is online, then try again.',
          )}
          onResolve={(approval, status) => resolve.mutate({ approval, status })}
        />
      )}
      {showDiagnosis && view.diagnosis && (
        <DiagnosisCard
          diagnosis={view.diagnosis}
          checks={view.checks}
          artifacts={view.artifacts}
          runId={run.id}
          fixApproval={fixApproval}
          resolving={fixApproval !== null && resolvingFor(fixApproval)}
          resolveError={commandError(
            resolve.error,
            'Could not resolve the approval — check that the runner is online, then try again.',
          )}
          onApproveFix={(approval) => resolve.mutate({ approval, status: 'approved' })}
        />
      )}
    </div>
  );
}
