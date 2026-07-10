// App shell (BIBLE §7.1): a minimal top bar with the Boardex wordmark on the left and
// a runner status pill on the right, over the routed page content. The pill's up/down
// signal is the /health poll; the global WS runner.status feed keeps the bench
// snapshot fresh for later readiness surfaces.
import { Link, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { StatusDot } from '../design';
import { api } from '../lib/api';
import { useGlobalEvents } from '../lib/globalStream';
import { useBenchStore } from '../lib/benchStore';

// Mirror the global stream's runner.status into the bench store. Rides the one shared
// global connection (globalStream) alongside the Home list's live run updates.
function useGlobalRunnerFeed(): void {
  const setBench = useBenchStore((state) => state.setBench);
  useGlobalEvents((event) => {
    if (event.type === 'runner.status') setBench(event.payload.bench);
  });
}

function RunnerPill() {
  // The /health poll is the authoritative up/down signal: retry is off so a downed
  // runner reads as offline immediately, and the interval flips the pill back to
  // online the moment the runner is restarted.
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
    refetchInterval: 5000,
    retry: false,
  });
  const online = health.isSuccess && health.data.ok;
  const runnerKind = health.data?.runnerKind;

  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-panel px-3 py-1 text-meta"
    >
      <StatusDot state={online ? 'online' : 'offline'} />
      <span className="font-medium text-text-primary">
        {online ? `Runner online${runnerKind ? ` · ${runnerKind}` : ''}` : 'Runner offline'}
      </span>
    </span>
  );
}

export default function Layout() {
  useGlobalRunnerFeed();
  return (
    <div className="min-h-screen bg-bg-app font-sans text-text-primary">
      <header className="flex h-14 items-center justify-between border-b border-border bg-bg-panel px-6">
        <div className="flex items-baseline gap-6">
          <Link to="/" className="text-section font-semibold text-text-primary">
            Boardex
          </Link>
          {/* The Board Profile Builder (§7.5) is a screen of its own; the top bar is
              the only place it can be reached from. */}
          <Link to="/boards" className="text-meta text-text-secondary hover:text-text-primary">
            Boards
          </Link>
        </div>
        <RunnerPill />
      </header>
      <Outlet />
    </div>
  );
}
