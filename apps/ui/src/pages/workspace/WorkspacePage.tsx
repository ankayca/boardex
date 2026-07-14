// Run Workspace — the three zones + evidence band (BIBLE §6.3/§7.3): left Board
// Context rail (280px), center Plan & Progress (fluid, min 560px), right Run Status
// & Approval rail (340px — status card, approval card, diagnosis card, stop), bottom
// Evidence Summary band (88px collapsed strip of check chips + evidence actions).
// A thin amber reconnecting bar sits above it all on a WS drop. Below 1280px the
// right rail stacks under center.
import type { BenchStatus, BoardProfile, RunView } from '@boardex/contract';
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
  // Frame v2 (T6.1b): the run title + status badge live in the shell's top bar.
  // The three-zone split keys on content width (container query, index.css) so
  // the sidebar participates; the center column caps at 940px — rails keep
  // their §6.3 widths and surplus space distributes to the gutters.
  return (
    <>
      <ReconnectingBar status={connection} />
      <main className="workspace-container px-6 py-6">
        <div className="workspace-grid">
          <BoardContextRail
            profile={profile}
            profileLoading={profileLoading}
            bench={bench}
            boardProfileId={run.boardProfileId}
          />
          <div className="min-w-0">
            <div className="mx-auto max-w-[940px]">
              <PlanTimeline view={view} />
            </div>
          </div>
          <aside aria-label="Run status and approval" className="workspace-rail">
            <StatusApprovalRail view={view} bench={bench} />
          </aside>
        </div>

        <EvidenceBand view={view} />
      </main>
    </>
  );
}
