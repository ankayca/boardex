// App frame v2 (T6.1b): the persistent left sidebar — wordmark, primary nav
// (Runs, Boards) with active states, the five most recent runs (live via the
// global stream, same ['runs'] invalidation contract as Home), and the runner
// status pill at the bottom (moved here from the old top bar). Collapses to a
// 56px icon rail; the choice is deliberately in-memory only (module state), so
// it survives navigation but resets on reload — no storage. T6.6: that module flag
// moved into lib/settings so Settings can drive the same collapse-by-default value
// (one source of truth), still module memory, still no storage.
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RunStatusIcon, StatusDot } from '../design';
import { api } from '../lib/api';
import { useGlobalEvents } from '../lib/globalStream';
import {
  getSidebarCollapsed,
  setSidebarCollapsed,
  useSettingsVersion,
} from '../lib/settings';
import { recentRuns } from './recentRuns';

function RunsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">
      <path
        d="M3 4h10M3 8h10M3 12h6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BoardsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">
      <rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M6.5 4V2M9.5 4V2M6.5 14v-2M9.5 14v-2M4 6.5H2M4 9.5H2M14 6.5h-2M14 9.5h-2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 1.5v1.7M8 12.8v1.7M14.5 8h-1.7M3.2 8H1.5M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2M12.6 12.6l-1.2-1.2M4.6 4.6L3.4 3.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">
      <path
        d={collapsed ? 'M6 4l4 4-4 4' : 'M10 4L6 8l4 4'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface NavItemProps {
  to: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  collapsed: boolean;
}

function NavItem({ to, label, icon, active, collapsed }: NavItemProps) {
  return (
    <NavLink
      to={to}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? label : undefined}
      className={`flex items-center gap-2.5 rounded-control px-2 py-1.5 text-body font-medium transition-colors duration-fast ease-motion ${
        active
          ? 'bg-neutral-badge-bg text-text-primary'
          : 'text-text-secondary hover:bg-canvas hover:text-text-primary'
      } ${collapsed ? 'justify-center' : ''}`}
    >
      <span className="shrink-0">{icon}</span>
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );
}

function RecentRuns({ collapsed }: { collapsed: boolean }) {
  const queryClient = useQueryClient();
  const runsQuery = useQuery({ queryKey: ['runs'], queryFn: () => api.listRuns() });

  // Same live contract as Home (§7.1): lifecycle events invalidate the
  // authoritative list; the dedicated terminals ride the global stream too.
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

  const recent = useMemo(() => recentRuns(runsQuery.data ?? []), [runsQuery.data]);
  // No runs yet: the sidebar's quiet onboarding equivalent of Home's demo action
  // (§7.1 / T6.5). Gated on runsQuery.isSuccess exactly like Home's first-use hero —
  // a genuine empty response, never a still-pending or failed fetch, so a cold start
  // with the runner down doesn't misread as "no runs, watch the demo". Hidden on the
  // icon rail, where the top of the app already shows the primary affordances.
  if (recent.length === 0) {
    if (collapsed || !runsQuery.isSuccess) return null;
    return (
      <div className="mt-6">
        <NavLink
          to="/demo"
          className="block rounded-control px-2 py-1.5 text-meta text-text-secondary transition-colors duration-fast ease-motion hover:bg-canvas hover:text-text-primary"
        >
          Watch a demo run
        </NavLink>
      </div>
    );
  }

  return (
    <div className="mt-6 min-h-0 overflow-y-auto">
      {!collapsed && (
        <p className="px-2 text-metadata font-medium uppercase tracking-wide text-text-secondary">Recent</p>
      )}
      <ul aria-label="Recent runs" className="mt-1 space-y-0.5">
        {recent.map((run) => (
          <li key={run.id}>
            <NavLink
              to={`/runs/${run.id}`}
              title={run.title}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-control px-2 py-1.5 text-meta transition-colors duration-fast ease-motion ${
                  isActive
                    ? 'bg-neutral-badge-bg text-text-primary'
                    : 'text-text-secondary hover:bg-canvas hover:text-text-primary'
                } ${collapsed ? 'justify-center' : ''}`
              }
            >
              <RunStatusIcon status={run.status} sizePx={12} className="shrink-0" />
              {!collapsed && <span className="truncate">{run.title}</span>}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunnerPill({ collapsed }: { collapsed: boolean }) {
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
  const label = online ? `Runner online${runnerKind ? ` · ${runnerKind}` : ''}` : 'Runner offline';

  if (collapsed) {
    return (
      <span role="status" aria-live="polite" aria-label={label} title={label} className="flex justify-center">
        <StatusDot state={online ? 'online' : 'offline'} />
      </span>
    );
  }
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-meta"
    >
      <StatusDot state={online ? 'online' : 'offline'} />
      <span className="truncate font-medium text-text-primary">{label}</span>
    </span>
  );
}

export function Sidebar() {
  // The collapse choice lives in lib/settings (module memory) so Settings and the
  // sidebar button read/write the same value; useSettingsVersion re-renders on change.
  useSettingsVersion();
  const collapsed = getSidebarCollapsed();
  const { pathname } = useLocation();
  const toggle = () => setSidebarCollapsed(!collapsed);

  const runsActive = pathname === '/' || pathname.startsWith('/runs');
  const boardsActive = pathname.startsWith('/boards');
  const settingsActive = pathname.startsWith('/settings');

  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-medium ease-motion ${
        collapsed ? 'w-14' : 'w-52'
      }`}
    >
      <div
        className={`flex h-12 shrink-0 items-center ${collapsed ? 'justify-center' : 'justify-between pl-4 pr-2'}`}
      >
        {!collapsed && (
          <Link to="/" className="text-section font-semibold text-text-primary">
            Boardex
          </Link>
        )}
        <button
          type="button"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          onClick={toggle}
          className="rounded-control p-1.5 text-text-secondary transition-colors duration-fast ease-motion hover:bg-canvas hover:text-text-primary"
        >
          <CollapseIcon collapsed={collapsed} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-2 pt-2">
        <nav aria-label="Primary" className="space-y-0.5">
          {/* T6.1c: a quiet "+" beside Runs — the sidebar's new-run affordance.
              Hidden on the icon rail; the top bar's New Run remains on Home. */}
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <NavItem
                to="/"
                label="Runs"
                icon={<RunsIcon />}
                active={runsActive}
                collapsed={collapsed}
              />
            </div>
            {!collapsed && (
              <NavLink
                to="/runs/new"
                aria-label="New run"
                title="New run"
                className="shrink-0 rounded-control p-1.5 text-text-secondary transition-colors duration-fast ease-motion hover:bg-canvas hover:text-text-primary"
              >
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">
                  <path
                    d="M8 3.5v9M3.5 8h9"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </NavLink>
            )}
          </div>
          <NavItem
            to="/boards"
            label="Boards"
            icon={<BoardsIcon />}
            active={boardsActive}
            collapsed={collapsed}
          />
        </nav>
        <RecentRuns collapsed={collapsed} />
      </div>

      <div className={`shrink-0 space-y-2 border-t border-border ${collapsed ? 'px-2 py-3' : 'p-3'}`}>
        <NavItem
          to="/settings"
          label="Settings"
          icon={<SettingsIcon />}
          active={settingsActive}
          collapsed={collapsed}
        />
        <RunnerPill collapsed={collapsed} />
      </div>
    </aside>
  );
}
