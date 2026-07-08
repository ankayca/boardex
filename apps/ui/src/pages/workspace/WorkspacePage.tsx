// Run Workspace — the three zones + evidence band (BIBLE §6.3/§7.3, T2.1 scope):
// left Board Context rail (280px), center Plan & Progress (fluid, min 560px), right
// Run Status & Approval rail (340px — placeholder until T2.2), bottom Evidence
// Summary band (88px collapsed — placeholder until T2.3). Below 1280px the right
// rail stacks under center. No approval UI, no stop control here.
import type { BenchStatus, BoardProfile, RunView } from '@boardex/contract';
import { Badge } from '../../design';
import { BoardContextRail } from './BoardContextRail';
import { PlanTimeline } from './PlanTimeline';

export interface WorkspacePageProps {
  view: RunView;
  profile: BoardProfile | null;
  profileLoading: boolean;
  bench: BenchStatus | null;
}

export function WorkspacePage({ view, profile, profileLoading, bench }: WorkspacePageProps) {
  const { run } = view;
  return (
    <main className="px-6 py-6">
      <header className="flex items-center gap-3">
        <h1 className="text-page font-semibold text-text-primary">{run.title}</h1>
        <Badge kind="status" value={run.status} />
      </header>

      <div className="mt-6 grid grid-cols-[280px_minmax(0,1fr)] gap-6 xl:grid-cols-[280px_minmax(560px,1fr)_340px]">
        <BoardContextRail
          profile={profile}
          profileLoading={profileLoading}
          bench={bench}
          boardProfileId={run.boardProfileId}
        />
        <PlanTimeline view={view} />
        <aside
          aria-label="Run status and approval"
          className="col-start-2 xl:col-auto xl:col-start-3"
        >
          <div className="rounded-card border border-border bg-bg-panel p-5 shadow-subtle">
            <h2 className="text-section font-semibold text-text-primary">Status &amp; approval</h2>
            <p className="mt-2 text-meta text-text-secondary">
              Run controls and approvals arrive with T2.2.
            </p>
          </div>
        </aside>
      </div>

      <section
        aria-label="Evidence summary"
        className="mt-6 flex h-[88px] items-center rounded-card border border-border bg-bg-panel px-5 shadow-subtle"
      >
        <p className="text-meta text-text-secondary">Evidence summary arrives with T2.3.</p>
      </section>
    </main>
  );
}
