// Right rail — Status & Approval (BIBLE §7.3, T2.2). Owns the two run commands
// (stop, resolve approval) and their idempotency: buttons stay disabled from click
// until the confirming event lands in the reduced view, and a 409 StateConflict is
// state refresh, not an error — the event stream reconciles the view (§5.3).
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Approval, BenchStatus, RunView } from '@boardex/contract';
import { RUN_STATUS_LABELS } from '../../design';
import { StateConflict } from '../../lib/apiErrors';
import { useRunCommands } from '../../lib/runCommands';
import { benchIssues } from '../../lib/benchReadiness';
import { BenchWarning } from '../composer/BenchReadiness';
import { deriveApprovalGate } from './approvalGate';
import { ApprovalCard } from './ApprovalCard';
import { DiagnosisCard } from './DiagnosisCard';
import { isTerminalStatus } from './elapsed';
import { evidenceHrefAt, evidenceTargets, reportHrefAt } from './evidence';
import { useEvidenceBase } from './evidenceBase';
import { deriveDualOutcome } from './outcome';
import { deriveProgress } from './progress';
import { StatusCard } from './StatusCard';

// The bench snapshot arrives as a prop (T6.5), not from useBenchStatus, so the rail
// stays free of the api client: the live workspace threads the real snapshot down,
// the demo threads null. The §7.2 hardware-approval warning still repeats here.
export function StatusApprovalRail({
  view,
  bench,
  demoMode = false,
}: {
  view: RunView;
  bench: BenchStatus | null;
  /** Demo replay (T6.5): Stop skips its confirm and exits the replay directly (P5). */
  demoMode?: boolean;
}) {
  const { run } = view;
  const base = useEvidenceBase(run.id);
  const commands = useRunCommands();
  // Review Diff targets the run's latest code_diff artifact, exactly as the evidence
  // band's Open Diff does; null when the run has produced none yet.
  const diffTarget = evidenceTargets(view).diff;

  const stop = useMutation({
    mutationFn: () => commands.stop(run.id),
    onError: (error) => {
      if (error instanceof StateConflict) stop.reset();
    },
  });

  const resolve = useMutation({
    mutationFn: ({ approval, status }: { approval: Approval; status: 'approved' | 'rejected' }) =>
      commands.resolveApproval(run.id, approval.id, status),
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
  // own report only (instruments: null), never on re-resolving a profile. The snapshot
  // is the prop threaded from the workspace (T6.5).
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

  const terminal = isTerminalStatus(run.status);
  const activeStep = view.steps.find((step) => step.status === 'active');

  // The reserved action slot's occupant (Sprint 7 P0, §7.3): the SAME slot —
  // directly under the sticky status card — holds the quiet autonomous state,
  // the approval surface when a gate activates, or the completion module.
  // Content swaps in place; the rail's geometry never reflows around it.
  const approvalSurface = gate !== null || (showDiagnosis && view.diagnosis !== undefined);

  return (
    <div className="h-full space-y-4">
      {/* §6.2 v2.3 aria-live: run-state changes and approval arrivals are
          announced — exactly these, never streamed log lines (the LogViewer is
          aria-live="off"). One polite region; its text change is the announcement. */}
      <p aria-live="polite" className="sr-only">
        {gate?.kind === 'ready'
          ? `Approval required: ${gate.approval.proposal.title}`
          : `Run status: ${RUN_STATUS_LABELS[run.status]}`}
      </p>
      <div className="rail-sticky">
        <StatusCard
          run={run}
          endedAt={view.endedAt}
          warnings={view.warnings}
          progress={deriveProgress(view)}
          outcome={deriveDualOutcome(view)}
          stopping={stopping}
          stopError={commandError(
            stop.error,
            'Could not stop the run — check that the runner is online, then try again.',
          )}
          onStop={() => stop.mutate()}
          confirmStop={!demoMode}
        />
      </div>

      <div data-testid="rail-action-slot" aria-label="Run actions" className="space-y-4">
        {approvalSurface ? (
          <>
            {hardwareApprovalIssues.length > 0 && <BenchWarning issues={hardwareApprovalIssues} />}
            {gate && fixApproval === null && (
              <ApprovalCard
                gate={gate}
                diffHref={diffTarget && evidenceHrefAt(base, diffTarget)}
                resolving={gate.kind === 'ready' && resolvingFor(gate.approval)}
                resolvingStatus={
                  gate.kind === 'ready' && resolvingFor(gate.approval)
                    ? (resolve.variables?.status ?? null)
                    : null
                }
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
          </>
        ) : terminal ? (
          <CompletionModule status={run.status} reportHref={reportTarget ? reportHrefAt(base) : null} />
        ) : (
          <AutonomousState status={run.status} activeStepTitle={activeStep?.title ?? null} />
        )}
      </div>
    </div>
  );
}

// The slot's quiet state while the agent works: no approval exists, and the
// operator sees WHAT is executing, live from RunView. White card like its
// sibling occupants so the swap reads as content change, not layout change.
function AutonomousState({
  status,
  activeStepTitle,
}: {
  status: RunView['run']['status'];
  activeStepTitle: string | null;
}) {
  const activity =
    activeStepTitle !== null
      ? `executing “${activeStepTitle}”`
      : status === 'planning'
        ? 'planning the run'
        : status === 'plan_ready'
          ? 'waiting for plan approval'
          : 'working';
  return (
    <section
      aria-label="No approval required"
      className="rounded-card border border-border bg-surface p-5"
    >
      <p className="text-meta text-text-secondary">
        <span className="font-medium text-text-primary">No approval required</span> · Boardex is{' '}
        {activity}
      </p>
    </section>
  );
}

// The slot's terminal state: the deliverable up front when it exists; a failed
// or stopped run without a report states the honest outcome instead — never an
// empty slot, never a dead end.
function CompletionModule({
  status,
  reportHref,
}: {
  status: RunView['run']['status'];
  reportHref: string | null;
}) {
  return (
    <section aria-label="Run complete" className="rounded-card border border-border bg-surface p-5">
      <h2 className="text-body font-semibold text-text-primary">
        {status === 'completed' ? 'Run complete' : status === 'stopped' ? 'Run stopped' : 'Run failed'}
      </h2>
      <p className="mt-1 text-meta text-text-secondary">
        {reportHref
          ? 'The evidence-linked validation report is ready.'
          : 'Evidence collected so far is retained. No validation report was produced.'}
      </p>
      {reportHref && (
        <Link
          to={reportHref}
          className="mt-3 flex h-10 w-full items-center justify-center rounded-control bg-accent px-4 text-body font-medium text-white transition-colors duration-fast ease-motion hover:bg-accent-hover"
        >
          Open Validation Report
        </Link>
      )}
    </section>
  );
}
