// Home / Runs (BIBLE §7.1): land, orient, resume. A "New Run" primary action, the run
// list ordered needs-attention → active → recent, a first-use empty hero, and a
// runner-offline banner (the list still renders from the last HTTP snapshot while the
// runner is down). Live updates ride the global WS: a run created or advanced in another
// tab invalidates the list here and reappears without a manual refresh.
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, EmptyState } from '../../design';
import { api } from '../../lib/api';
import { useGlobalEvents } from '../../lib/globalStream';
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

  // Live: a run created or advanced anywhere refreshes the authoritative list. GET /runs
  // is the source of truth, so invalidate rather than patch the cache by hand.
  useGlobalEvents((event) => {
    if (event.type === 'run.created' || event.type === 'run.status_changed') {
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    }
  });

  const online = health.isSuccess && health.data.ok;

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

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-page font-semibold text-text-primary">Runs</h1>
        <NewRunButton />
      </div>

      {!online && <RunnerOfflineBanner onRetry={retry} />}

      {runs.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-bg-panel">
          {runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              boardName={boardNames.get(run.boardProfileId) ?? run.boardProfileId}
            />
          ))}
        </ul>
      ) : runsQuery.isPending ? (
        <p className="text-body text-text-secondary">Loading runs…</p>
      ) : runsQuery.isSuccess ? (
        // A genuine empty response — the first-use hero (§7.1). We DON'T show this on a
        // failed fetch: an offline cold start has no runs to list, but the banner above
        // already explains why, and "start your first run" would misread the situation.
        <EmptyState
          title="No runs yet"
          description="Boardex brings up boards for you — describe a task and it plans, flashes, measures, and reports. Start with your first run."
          action={<NewRunButton />}
        />
      ) : null}
    </main>
  );
}
