// /boards (BIBLE §7.5): the profiles the bench knows about. One row per profile —
// name, MCU, the instruments it references, and the way into the builder. Data is
// GET /board-profiles via TanStack Query, the same cache the composer's selector reads.
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { BenchStatus, BoardProfile } from '@boardex/contract';
import { Button, EmptyState } from '../../design';
import { api } from '../../lib/api';
import { matchInstruments } from '../../lib/benchReadiness';
import { useBenchStatus } from '../../lib/useBenchStatus';

// T4.2 F4 ruling, applied to this list too (T6.1b): rows show the DEVICE NAME —
// the thing an operator recognises on the bench — resolved by reference against
// the live bench; the stored reference/id stays in the edit view. With no bench
// snapshot (or an unresolved reference) the stored reference is all we truthfully
// have, so it renders as-is — never an assumed anything.
function instrumentSummary(profile: BoardProfile, bench: BenchStatus | null): string {
  const { debugProbe, logicAnalyzer } = profile.instruments;
  if (!bench) return logicAnalyzer ? `${debugProbe} · ${logicAnalyzer}` : debugProbe;
  return matchInstruments(profile.instruments, bench)
    .map((match) => match.deviceName ?? match.reference)
    .join(' · ');
}

function ProfileRow({ profile, bench }: { profile: BoardProfile; bench: BenchStatus | null }) {
  return (
    <li className="flex items-center gap-4 rounded-card border border-border bg-surface px-5 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-text-primary">{profile.name}</p>
        <p className="mt-0.5 text-meta text-text-secondary">{profile.mcu}</p>
        <p className="mt-1 truncate text-meta text-text-secondary">
          {instrumentSummary(profile, bench)}
        </p>
      </div>
      <Link
        to={`/boards/${profile.id}`}
        className="shrink-0 rounded-control border border-border px-4 py-2 text-body font-medium text-text-primary transition-colors hover:bg-canvas"
      >
        Edit
      </Link>
    </li>
  );
}

export default function BoardsPage() {
  const navigate = useNavigate();
  const profilesQuery = useQuery({
    queryKey: ['board-profiles'],
    queryFn: () => api.listBoardProfiles(),
  });
  const bench = useBenchStatus();

  const newProfile = (
    <Button variant="primary" className="whitespace-nowrap" onClick={() => navigate('/boards/new')}>
      New Profile
    </Button>
  );

  // Frame v2 (T6.1b): the page title and the New Profile action live in the
  // shell's top bar; content is table-width, left-aligned.
  return (
    <main className="max-w-[1040px] px-8 py-8">
      <p className="text-body text-text-secondary">
        Reusable board setup: firmware commands, instruments, safety limits, and the
        connections to confirm before every run.
      </p>

      <div className="mt-6">
        {profilesQuery.isPending && (
          <p role="status" className="text-body text-text-secondary">
            Loading board profiles…
          </p>
        )}

        {profilesQuery.isError && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-card border border-warn bg-warn-bg px-5 py-4"
          >
            <div className="flex-1">
              <p className="text-body font-medium text-warn">Could not load board profiles</p>
              <p className="mt-1 text-meta text-text-secondary">
                Check that the runner is online, then retry.
              </p>
            </div>
            <Button
              variant="secondary"
              className="shrink-0"
              onClick={() => void profilesQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        )}

        {profilesQuery.isSuccess &&
          (profilesQuery.data.length === 0 ? (
            <EmptyState
              title="No board profiles yet"
              description="A profile tells Boardex how to build, flash, and observe one board. Create one to start a run."
              action={newProfile}
            />
          ) : (
            <ul aria-label="Board profiles" className="space-y-3">
              {profilesQuery.data.map((profile) => (
                <ProfileRow key={profile.id} profile={profile} bench={bench} />
              ))}
            </ul>
          ))}
      </div>
    </main>
  );
}
