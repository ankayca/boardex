// App frame v2 (T6.1b): the top bar slims to a 48px context header — the current
// page's title (or run title + status badge, live from the reduced view), with
// right-aligned page actions. Titles derive from the route here rather than from
// page-side registration, so pages carry no header plumbing and the bar can never
// disagree with the URL. Stop Run stays in the workspace rail, per the task.
import type { ReactNode } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import type { RunStatus } from '@boardex/contract';
import { Badge, Button } from '../design';
import { useRunView } from '../lib/runStore';

interface HeaderInfo {
  title: string;
  badge: RunStatus | null;
  actions: ReactNode;
}

function useHeaderInfo(): HeaderInfo {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // /runs/new also matches /runs/:id — the id guard below handles it.
  const runMatch = useMatch('/runs/:id/*');
  const runExact = useMatch('/runs/:id');
  const runId = (runExact ?? runMatch)?.params.id ?? '';
  const isRunRoute = runId !== '' && runId !== 'new';
  const view = useRunView(isRunRoute ? runId : '');

  if (pathname === '/') {
    return {
      title: 'Runs',
      badge: null,
      actions: (
        <Button variant="primary" className="whitespace-nowrap" onClick={() => navigate('/runs/new')}>
          New Run
        </Button>
      ),
    };
  }
  if (pathname === '/runs/new') {
    return { title: 'New Run', badge: null, actions: null };
  }
  if (isRunRoute) {
    return {
      title: view?.run.title ?? 'Run',
      badge: view?.run.status ?? null,
      actions: null,
    };
  }
  if (pathname === '/boards') {
    return {
      title: 'Board Profiles',
      badge: null,
      actions: (
        <Button
          variant="primary"
          className="whitespace-nowrap"
          onClick={() => navigate('/boards/new')}
        >
          New Profile
        </Button>
      ),
    };
  }
  if (pathname === '/boards/new') {
    return { title: 'New Board Profile', badge: null, actions: null };
  }
  if (pathname.startsWith('/boards/')) {
    return { title: 'Board Profile', badge: null, actions: null };
  }
  if (pathname === '/settings') {
    return { title: 'Settings', badge: null, actions: null };
  }
  return { title: 'Boardex', badge: null, actions: null };
}

export function TopBar() {
  const { title, badge, actions } = useHeaderInfo();
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-bg-panel px-6">
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="truncate text-body font-semibold text-text-primary">{title}</h1>
        {badge && <Badge kind="status" value={badge} />}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
