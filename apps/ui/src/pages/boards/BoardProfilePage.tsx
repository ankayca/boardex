// /boards/new and /boards/:id (BIBLE §7.5). This route's only job beyond hosting the
// form is resolving which profile is being edited — and refusing to guess.
//
// Fail-closed (decisions.md 2026-07-07): a form that could not load its profile shows
// the blocked pattern, never an empty editable form. An empty form here would POST a
// blank profile over a real one on the runner, silently destroying the commands,
// safety limits and connection checklist a run depends on.
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../design';
import { api } from '../../lib/api';
import { ProfileForm } from './ProfileForm';
import { blankDraft, fromProfile } from './profileDraft';

function BlockedCard({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action: ReactNode;
}) {
  return (
    <div role="alert" className="rounded-card border border-warn bg-warn-bg px-5 py-4">
      <p className="text-body font-medium text-warn">{title}</p>
      <p className="mt-1 text-meta text-text-secondary">{detail}</p>
      <div className="mt-3">{action}</div>
    </div>
  );
}

export default function BoardProfilePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === undefined;

  // A new profile's id is minted once, not on every render (§4: ids are opaque strings).
  const [newDraft] = useState(() => blankDraft());

  const profilesQuery = useQuery({
    queryKey: ['board-profiles'],
    queryFn: () => api.listBoardProfiles(),
    enabled: !isNew,
  });
  const profile = profilesQuery.isSuccess
    ? (profilesQuery.data.find((candidate) => candidate.id === id) ?? null)
    : null;

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <Link to="/boards" className="text-meta text-text-secondary hover:text-text-primary">
        ← Board Profiles
      </Link>
      <h1 className="mt-2 text-page font-semibold text-text-primary">
        {isNew ? 'New board profile' : (profile?.name ?? 'Board profile')}
      </h1>
      <p className="mt-1 text-body text-text-secondary">
        {isNew
          ? 'Describe the board once; every run against it reuses this setup.'
          : 'Editing this profile changes how future runs build, flash, and observe this board.'}
      </p>

      <div className="mt-8">
        {isNew ? (
          <ProfileForm mode="new" initial={newDraft} onSaved={() => navigate('/boards')} />
        ) : profilesQuery.isPending ? (
          <p role="status" className="text-body text-text-secondary">
            Loading the board profile…
          </p>
        ) : profilesQuery.isError ? (
          <BlockedCard
            title="Board profile unavailable"
            detail="This profile could not be loaded, so editing it would overwrite settings that are not on screen. Retry once the runner is reachable."
            action={
              <Button variant="secondary" onClick={() => void profilesQuery.refetch()}>
                Retry
              </Button>
            }
          />
        ) : profile ? (
          <ProfileForm
            key={profile.id}
            mode="edit"
            initial={fromProfile(profile)}
            onSaved={() => navigate('/boards')}
          />
        ) : (
          <BlockedCard
            title="Board profile not found"
            detail={`The runner has no profile with id "${id ?? ''}". It may have been removed.`}
            action={
              <Button variant="secondary" onClick={() => navigate('/boards')}>
                Back to profiles
              </Button>
            }
          />
        )}
      </div>
    </main>
  );
}
