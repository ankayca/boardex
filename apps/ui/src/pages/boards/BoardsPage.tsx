// /boards (BIBLE §7.5): the profiles the bench knows about. One row per profile —
// name, MCU, the instruments it references, and the way into the builder. Data is
// GET /board-profiles via TanStack Query, the same cache the composer's selector reads.
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { BoardProfile } from '@boardex/contract';
import { Button, EmptyState } from '../../design';
import { api } from '../../lib/api';

/** The instruments this profile claims, as one scannable line. */
function instrumentSummary(profile: BoardProfile): string {
  const { debugProbe, logicAnalyzer } = profile.instruments;
  return logicAnalyzer ? `${debugProbe} · ${logicAnalyzer}` : debugProbe;
}

function ProfileRow({ profile }: { profile: BoardProfile }) {
  return (
    <li className="flex items-center gap-4 rounded-card border border-border bg-bg-panel px-5 py-4 shadow-subtle">
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-text-primary">{profile.name}</p>
        <p className="mt-0.5 text-meta text-text-secondary">{profile.mcu}</p>
        <p className="mt-1 truncate text-meta text-text-secondary">{instrumentSummary(profile)}</p>
      </div>
      <Link
        to={`/boards/${profile.id}`}
        className="shrink-0 rounded-button border border-border px-4 py-2 text-body font-medium text-text-primary transition-colors hover:bg-bg-app"
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

  const newProfile = (
    <Button variant="primary" onClick={() => navigate('/boards/new')}>
      New Profile
    </Button>
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-page font-semibold text-text-primary">Board Profiles</h1>
          <p className="mt-1 text-body text-text-secondary">
            Reusable board setup: firmware commands, instruments, safety limits, and the
            connections to confirm before every run.
          </p>
        </div>
        {newProfile}
      </div>

      <div className="mt-8">
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
                <ProfileRow key={profile.id} profile={profile} />
              ))}
            </ul>
          ))}
      </div>
    </main>
  );
}
