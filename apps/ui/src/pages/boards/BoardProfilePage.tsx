// /boards/new and /boards/:id (BIBLE §7.5). This route's only job beyond hosting the
// form is resolving which profile is being edited — and refusing to guess.
//
// Fail-closed (decisions.md 2026-07-07): a form that could not load its profile shows
// the blocked pattern, never an empty editable form. An empty form here would POST a
// blank profile over a real one on the runner, silently destroying the commands,
// safety limits and connection checklist a run depends on.
//
// That guard keys on "is there a profile in hand", not "did the last fetch fail" (T4.1
// review F1): once a profile has loaded, a failed BACKGROUND refetch must not tear the
// form down and take the user's unsaved edits with it. Then the fail-closed danger has
// already passed — the form holds a real profile — so the failure becomes an inline
// notice and the edits stay put.
import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
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

// A refetch failed while the form already holds a loaded profile: nothing is lost, so
// this warns (amber, D14) rather than blocking. role="status", not "alert" — the
// blocked cards above own the alert role, and this interrupts nothing.
function RefreshFailedNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-card border border-warn bg-warn-bg px-5 py-4"
    >
      <div className="flex-1">
        <p className="text-body font-medium text-warn">
          Couldn’t refresh from the runner — you’re editing the last loaded copy
        </p>
        <p className="mt-1 text-meta text-text-secondary">
          Your edits are intact. Saving will overwrite whatever the runner holds now.
        </p>
      </div>
      <Button variant="secondary" onClick={onRetry} className="shrink-0">
        Retry
      </Button>
    </div>
  );
}

export default function BoardProfilePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === undefined;

  // Quick Start's "Advanced" link hands the path over rather than making the user
  // retype it; every other field stays blank (v0). Nothing else is carried.
  const handoff = (useLocation().state ?? {}) as { repoPath?: string };

  // A new profile's id is minted once, not on every render (§4: ids are opaque strings).
  const [newDraft] = useState(() => ({
    ...blankDraft(),
    repoPath: handoff.repoPath?.trim() ?? '',
  }));

  const profilesQuery = useQuery({
    queryKey: ['board-profiles'],
    queryFn: () => api.listBoardProfiles(),
    enabled: !isNew,
  });
  // The last list the runner gave us, successful refetch or not.
  const profiles = profilesQuery.data;
  const profile = profiles?.find((candidate) => candidate.id === id) ?? null;
  const neverLoaded = profiles === undefined;
  const refreshFailed = profilesQuery.isError && !neverLoaded;

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
          ? 'Advanced setup: every field by hand. Quick Start in the composer compiles most of these from your repo path and the bench scan.'
          : 'Editing this profile changes how future runs build, flash, and observe this board.'}
      </p>

      <div className="mt-8 space-y-4">
        {isNew ? (
          <ProfileForm mode="new" initial={newDraft} onSaved={() => navigate('/boards')} />
        ) : profilesQuery.isError && neverLoaded ? (
          <BlockedCard
            title="Board profile unavailable"
            detail="This profile could not be loaded, so editing it would overwrite settings that are not on screen. Retry once the runner is reachable."
            action={
              <Button variant="secondary" onClick={() => void profilesQuery.refetch()}>
                Retry
              </Button>
            }
          />
        ) : neverLoaded ? (
          <p role="status" className="text-body text-text-secondary">
            Loading the board profile…
          </p>
        ) : profile ? (
          <>
            {refreshFailed && <RefreshFailedNotice onRetry={() => void profilesQuery.refetch()} />}
            <ProfileForm
              key={profile.id}
              mode="edit"
              initial={fromProfile(profile)}
              onSaved={() => navigate('/boards')}
            />
          </>
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
