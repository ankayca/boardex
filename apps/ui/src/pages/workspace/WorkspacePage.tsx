// Run Workspace — the three zones + evidence band (BIBLE §6.3/§7.3): left Board
// Context rail (280px), center Plan & Progress (fluid, min 560px), right Run Status
// & Approval rail (340px — status card, approval card, diagnosis card, stop), bottom
// Evidence Summary band (88px collapsed strip of check chips + evidence actions).
// A thin amber reconnecting bar sits above it all on a WS drop. Below 1280px the
// right rail stacks under center.
import type { BenchStatus, BoardProfile, RunView } from '@boardex/contract';
import { Badge } from '../../design';
import type { RunStreamStatus } from '../../lib/runStream';
import { BoardContextRail } from './BoardContextRail';
import { EvidenceBand } from './EvidenceBand';
import { PlanTimeline } from './PlanTimeline';
import { ReconnectingBar } from './ReconnectingBar';
import { StatusApprovalRail } from './StatusApprovalRail';

export interface WorkspacePageProps {
  view: RunView;
  profile: BoardProfile | null;
  profileLoading: boolean;
  bench: BenchStatus | null;
  connection: RunStreamStatus;
}

export function WorkspacePage({
  view,
  profile,
  profileLoading,
  bench,
  connection,
}: WorkspacePageProps) {
  const { run } = view;
  return (
    <>
      <ReconnectingBar status={connection} />
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
            <StatusApprovalRail view={view} />
          </aside>
        </div>

        <EvidenceBand view={view} />
      </main>
    </>
  );
}
