// Right rail — Status & Approval (BIBLE §7.3, T2.2). Owns the two run commands
// (stop, resolve approval) and their idempotency: buttons stay disabled from click
// until the confirming event lands in the reduced view, and a 409 StateConflict is
// state refresh, not an error — the event stream reconciles the view (§5.3).
import { useMutation } from '@tanstack/react-query';
import type { Approval, RunView } from '@boardex/contract';
import { api, StateConflict } from '../../lib/api';
import { deriveApprovalGate } from './approvalGate';
import { ApprovalCard } from './ApprovalCard';
import { DiagnosisCard } from './DiagnosisCard';
import { StatusCard } from './StatusCard';

export function StatusApprovalRail({ view }: { view: RunView }) {
  const { run } = view;

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

  const awaiting = run.status === 'awaiting_approval';
  const gate = awaiting ? deriveApprovalGate(view) : null;
  // The Diagnosis Card shows while diagnosing and stays through the fix-approval
  // gate (§2.2 "Failed measurement": likely causes + Approve Fix Plan together).
  // Once the fix is approved and the run moves on, it leaves the rail.
  const showDiagnosis = view.diagnosis !== undefined && (run.status === 'diagnosing' || awaiting);
  const fixApproval = gate?.kind === 'ready' ? gate.approval : null;

  // isSuccess holds the buttons disabled until the resolved/stopped event arrives;
  // the approval-id check re-arms them if a later approval reuses this mutation.
  const stopping = stop.isPending || stop.isSuccess;
  const resolvingFor = (approval: Approval): boolean =>
    resolve.isPending || (resolve.isSuccess && resolve.variables?.approval.id === approval.id);

  const commandError = (error: unknown, message: string): string | null =>
    error && !(error instanceof StateConflict) ? message : null;

  return (
    <div className="space-y-4">
      <StatusCard
        run={run}
        endedAt={view.endedAt}
        stopping={stopping}
        stopError={commandError(
          stop.error,
          'Could not stop the run — check that the runner is online, then try again.',
        )}
        onStop={() => stop.mutate()}
      />
      {gate && (
        <ApprovalCard
          gate={gate}
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
          runId={run.id}
          fixApproval={fixApproval}
          resolving={fixApproval !== null && resolvingFor(fixApproval)}
          onApproveFix={(approval) => resolve.mutate({ approval, status: 'approved' })}
        />
      )}
    </div>
  );
}
