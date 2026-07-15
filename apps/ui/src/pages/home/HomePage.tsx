// Home / Runs (BIBLE §7.1): land, orient, resume. A "New Run" primary action, the run
// list ordered needs-attention → active → recent, a first-use empty hero, and a
// runner-offline banner (the list still renders from the last HTTP snapshot while the
// runner is down). Live updates ride the global WS: a run created or advanced in another
// tab invalidates the list here and reappears without a manual refresh.
import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, EmptyState } from '../../design';
import { api } from '../../lib/api';
import { benchAttentionCount, benchAttentionLabel } from '../../lib/benchReadiness';
import { useGlobalEvents } from '../../lib/globalStream';
import { useBenchStatus } from '../../lib/useBenchStatus';
import { RunRow } from './RunRow';
import { sortRunSummaries } from './nextAction';

function NewRunButton() {
  const navigate = useNavigate();
  return (
    <Button variant="primary" onClick={() => navigate('/runs/new')}>
      New Run
    </Button>
  );
}

// The first-run hero's two actions (§7.1 / T6.5): start a real run, or watch the
// recorded demo run — the latter works offline, which is exactly when onboarding
// happens (the runner may not be up yet).
function HeroActions() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <NewRunButton />
      <Button variant="secondary" onClick={() => navigate('/demo')}>
        Watch a demo run
      </Button>
    </div>
  );
}

// Amber, per D14 (a warning that needs attention) — the runner is unreachable, but the
// list below still renders from the last successful GET /runs (§7.1).
function RunnerOfflineBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mb-6 flex items-start gap-3 rounded-card border border-warn bg-warn-bg px-5 py-4">
      <div className="flex-1">
        <p className="text-body font-medium text-warn">Runner offline</p>
        <p className="mt-1 text-meta text-text-secondary">
          Can&apos;t reach the runner. Runs below are the last known state. Check that the
          runner process is running and reachable, then retry.
        </p>
      </div>
      <Button variant="secondary" onClick={onRetry} className="shrink-0">
        Retry
      </Button>
    </div>
  );
}

// Bench attention (T4.2 item 4). Placement: directly under the runner-offline banner
// slot, above the run list — the top bar's runner pill is the shell's (§7.1 gives it
// no bench detail), and Home's banner region is already where "something is wrong out
// there" lives. Advisory only: it never gates New Run, and it stays a single line so
// it cannot compete with the runs it sits above.
function BenchAttentionLine({ count }: { count: number }) {
  return (
    <p role="status" className="mb-6 text-meta">
      <Link
        to="/boards"
        className="text-warn underline underline-offset-2 hover:no-underline"
      >
        {benchAttentionLabel(count)}
      </Link>
    </p>
  );
}

export default function HomePage() {
  const queryClient = useQueryClient();

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
    refetchInterval: 5000,
    retry: false,
  });
  const runsQuery = useQuery({ queryKey: ['runs'], queryFn: () => api.listRuns() });
  const profilesQuery = useQuery({
    queryKey: ['board-profiles'],
    queryFn: () => api.listBoardProfiles(),
  });

  // Live: a run created, advanced, or ended anywhere refreshes the authoritative list.
  // The dedicated terminals ride the global stream without a redundant
  // run.status_changed (§5.3 v2.0), so they must invalidate too — or a run that ends
  // via run.completed/failed/stopped keeps its stale row until a manual refresh.
  // GET /runs is the source of truth, so invalidate rather than patch the cache.
  useGlobalEvents((event) => {
    switch (event.type) {
      case 'run.created':
      case 'run.status_changed':
      case 'run.completed':
      case 'run.failed':
      case 'run.stopped':
        void queryClient.invalidateQueries({ queryKey: ['runs'] });
        break;
      default:
        break;
    }
  });

  const online = health.isSuccess && health.data.ok;

  // Gated on holding a snapshot that postdates the current connection, not on /health
  // (T4.2 review F1). useBenchStatus drops the snapshot when the global socket leaves
  // 'open', so a bench we cannot currently see reports nothing at all — including the
  // case /health alone would miss, where HTTP is fine and only the socket died. A
  // downed runner therefore suppresses this line without a special case: no socket, no
  // snapshot, and the offline banner above already says why.
  const bench = useBenchStatus();
  const attention = benchAttentionCount(bench);

  const boardNames = useMemo(
    () => new Map((profilesQuery.data ?? []).map((p) => [p.id, p.name] as const)),
    [profilesQuery.data],
  );

  // `runsQuery.data` holds the last successful snapshot even when a refetch later fails
  // (runner went down), which is exactly what "list still renders from HTTP" needs.
  const runs = useMemo(() => sortRunSummaries(runsQuery.data ?? []), [runsQuery.data]);

  const retry = () => {
    void health.refetch();
    void runsQuery.refetch();
    void profilesQuery.refetch();
  };

  // Frame v2 (T6.1b): the page title and the header New Run action live in the
  // shell's top bar now; content declares its own width — table-width,
  // left-aligned in the content area.
  return (
    <main className="max-w-[1040px] px-8 py-8">
      {!online && <RunnerOfflineBanner onRetry={retry} />}
      {attention > 0 && <BenchAttentionLine count={attention} />}

      {runs.length > 0 ? (
        <div className="overflow-hidden rounded-card border border-border bg-bg-panel">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-2.5 text-label font-medium uppercase text-text-secondary">
                  Status
                </th>
                <th className="w-2/5 px-4 py-2.5 text-label font-medium uppercase text-text-secondary">
                  Run
                </th>
                <th className="w-1/5 px-4 py-2.5 text-label font-medium uppercase text-text-secondary">
                  Board
                </th>
                <th className="px-4 py-2.5 text-label font-medium uppercase text-text-secondary">
                  Updated
                </th>
                <th className="px-4 py-2.5">
                  <span className="sr-only">Next action</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  boardName={boardNames.get(run.boardProfileId) ?? run.boardProfileId}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : runsQuery.isPending ? (
        <p className="text-body text-text-secondary">Loading runs…</p>
      ) : runsQuery.isSuccess ? (
        // A genuine empty response — the first-use hero (§7.1). We DON'T show this on a
        // failed fetch: an offline cold start has no runs to list, but the banner above
        // already explains why, and "start your first run" would misread the situation.
        // T6.1c: the first-use hero floats on the canvas ~35vh down, no card chrome.
        <EmptyState
          title="Bring up your first board"
          description="Describe a bring-up task in plain language — Boardex plans it, flashes, measures, and reports, with every result linked to its evidence."
          action={<HeroActions />}
          frameless
          className="mt-[24vh]"
        />
      ) : null}
    </main>
  );
}
