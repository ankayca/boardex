// /runs/:id (BIBLE §7.2/§7.3): while the run is in a pre-execution state
// (draft/planning/plan_ready) this page stays in composer mode — the submitted task,
// context chips, bench readiness, then the plan rendered in place when
// run.plan_generated arrives, and Approve Plan → POST plan/approve behind the D12
// connection checklist. Any later status hands over to the Run Workspace (T2.1).
// State comes exclusively from the run store's reduced view (D5), fed by the run WS
// + HTTP replay.
import { Link, useMatch, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Run } from '@boardex/contract';
import { Button } from '../../design';
import { api, StateConflict } from '../../lib/api';
import { liveRunCommands } from '../../lib/liveRunCommands';
import { RunCommandsProvider } from '../../lib/runCommands';
import { useRunView } from '../../lib/runStore';
import { useRunStream } from '../../lib/useRunStream';
import { EvidenceDrawer } from '../evidence/EvidenceDrawer';
import { WorkspacePage } from '../workspace/WorkspacePage';
import { benchIssues } from '../../lib/benchReadiness';
import { useBenchStatus } from '../../lib/useBenchStatus';
import { BenchReadiness } from './BenchReadiness';
import { ContextChips } from './ContextChips';
import { PlanReview } from './PlanReview';

const COMPOSER_STATUSES: ReadonlySet<Run['status']> = new Set(['draft', 'planning', 'plan_ready']);

// Fail-closed blocked state (T1.3 review finding 1, decisions.md 2026-07-07): with the
// profile unresolved there is no D12 checklist to confirm, so approval is blocked
// outright — Approve Plan is not rendered at all, not merely disabled.
function ProfileBlockedCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-card border border-warn bg-warn-bg px-5 py-4">
      <p className="text-body font-medium text-warn">Board profile unavailable</p>
      <p className="mt-1 text-meta text-text-secondary">
        The board profile for this run could not be loaded, so bench connections cannot be
        confirmed. Plan approval is blocked until the profile loads.
      </p>
      <Button variant="secondary" onClick={onRetry} className="mt-3">
        Retry
      </Button>
    </div>
  );
}

export default function RunPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  // Evidence Detail (§7.4) is a drawer over this page: /runs/:id/evidence renders
  // the same RunPage with the drawer open; closing it returns to /runs/:id.
  const evidenceOpen = useMatch('/runs/:id/evidence') !== null;

  const connection = useRunStream(id);
  const view = useRunView(id);

  const profilesQuery = useQuery({
    queryKey: ['board-profiles'],
    queryFn: () => api.listBoardProfiles(),
  });
  const bench = useBenchStatus();

  const approve = useMutation({
    mutationFn: () => api.approvePlan(id),
    onError: (error) => {
      // A 409 means the run already moved on; the event stream reconciles the view,
      // so a StateConflict is not an error to surface (§5.3).
      if (error instanceof StateConflict) approve.reset();
    },
  });

  if (!view) {
    // Fail-closed not-found (T5.2 review F2): GET /runs/{id}/events answered 404 —
    // the runner does not know this run id (§5.3), the stream stopped retrying,
    // and pretending to connect would be a lie. Honest state, way back out.
    if (connection === 'not_found') {
      return (
        <main className="mx-auto max-w-3xl px-6 py-16">
          <h1 className="text-page font-semibold text-text-primary">
            Run not found on the runner
          </h1>
          <p className="mt-2 text-body text-text-secondary">
            The runner has no run with this id. It may belong to a different runner instance,
            or the runner&rsquo;s history may have been cleared.
          </p>
          <Link
            to="/"
            className="mt-4 inline-block text-body font-medium text-accent underline underline-offset-2 hover:text-accent-hover"
          >
            Back to Runs
          </Link>
        </main>
      );
    }
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-body text-text-secondary">Connecting to run…</p>
      </main>
    );
  }

  const { run } = view;

  // Fail-closed (decisions.md 2026-07-07): the profile is resolved only when the query
  // succeeded AND the run's boardProfileId is in the list. Anything else — pending,
  // errored, or unknown id — is unresolved safety context and blocks approval.
  const profile = profilesQuery.isSuccess
    ? (profilesQuery.data.find((p) => p.id === run.boardProfileId) ?? null)
    : null;

  const evidenceDrawer = evidenceOpen ? (
    <EvidenceDrawer
      view={view}
      documents={profile?.documents}
      onClose={() => navigate(`/runs/${id}`)}
    />
  ) : null;

  if (!COMPOSER_STATUSES.has(run.status)) {
    return (
      <>
        {/* Live run commands (stop / resolve-approval) are api-backed here; the demo
            shell mounts a local provider instead (T6.5). */}
        <RunCommandsProvider value={liveRunCommands}>
          <WorkspacePage
            view={view}
            profile={profile}
            profileLoading={profilesQuery.isPending}
            bench={bench}
            connection={connection}
          />
        </RunCommandsProvider>
        {evidenceDrawer}
      </>
    );
  }
  const planReady = run.status === 'plan_ready' && run.plan !== undefined;

  // Frame v2 (T6.1b): the run title + status badge live in the shell's top bar.
  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <div className="space-y-4">
        <p className="whitespace-pre-wrap rounded-card border border-border bg-surface p-5 text-section text-text-primary">
          {run.taskPrompt}
        </p>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {profile ? (
            <ContextChips profile={profile} />
          ) : (
            <p className="text-meta text-text-secondary">Board: {run.boardProfileId}</p>
          )}
        </div>

        <BenchReadiness bench={bench} instruments={profile?.instruments ?? null} />

        {planReady && run.plan ? (
          profile ? (
            <PlanReview
              plan={run.plan}
              riskSummary={view.riskSummary ?? null}
              checklist={profile.connectionChecklist}
              profileResolved
              issues={benchIssues(bench, profile.instruments)}
              approving={approve.isPending}
              approveError={
                approve.isError && !(approve.error instanceof StateConflict)
                  ? 'Could not approve the plan — check that the runner is online, then try again.'
                  : null
              }
              onApprove={() => approve.mutate()}
              onEditTask={() =>
                navigate('/runs/new', {
                  state: { taskPrompt: run.taskPrompt, boardProfileId: run.boardProfileId },
                })
              }
            />
          ) : profilesQuery.isPending ? (
            <p role="status" className="text-body text-text-secondary">
              Loading the board profile…
            </p>
          ) : (
            <ProfileBlockedCard onRetry={() => void profilesQuery.refetch()} />
          )
        ) : (
          <p role="status" className="text-body text-text-secondary">
            Generating the plan…
          </p>
        )}
      </div>
      {evidenceDrawer}
    </main>
  );
}
