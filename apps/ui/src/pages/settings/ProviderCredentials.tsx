// Settings → Model provider (§7.7). Per provider the runner advertises: whether a key
// is configured, the runner's masked hint, a password field to set one, and Remove.
//
// FEATURE-DETECTED (lib/credentials): a runner that advertises no `credentials` on
// /health has no such section at all — not an empty one, not a disabled one. The whole
// capability is mock-prototyped and stands as a §10.5 proposal (docs/decisions.md,
// 2026-07-28), so an absent capability is a missing feature, never an assumed one.
//
// SECRETS DISCIPLINE, UI side: the typed key is PASS-THROUGH. It lives in one component
// state field, rides one PUT, and the field is cleared ALWAYS — on success and on
// failure alike — so nothing secret rests in the browser after a Save attempt. There is
// deliberately no localStorage/sessionStorage anywhere near this, and no module-memory
// store either (lib/settings exists to be read by the app; a key must not be readable
// by anything). The only credential material ever rendered is the runner's masked hint.
//
// D14: every unconfigured or rejected state here is AMBER — a missing key is a warning
// to resolve, not a run that failed. Red stays reserved for fail/stop.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../design';
import {
  CREDENTIALS_QUERY_KEY,
  credentialsApi,
  providersOrNull,
  type ProviderCredential,
} from '../../lib/credentials';

function ProviderRow({ credential }: { credential: ProviderCredential }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const inputId = `credential-${credential.provider}`;

  const refresh = (): Promise<unknown> =>
    queryClient.invalidateQueries({ queryKey: CREDENTIALS_QUERY_KEY });

  const save = useMutation({
    mutationFn: async () => {
      const key = draft;
      // Cleared BEFORE the await resolves the outcome: the field must not retain the
      // typed key for even the duration of a slow or failing request.
      setDraft('');
      setError(null);
      setSaved(false);
      await credentialsApi.put(credential.provider, key);
    },
    onSuccess: async () => {
      setSaved(true);
      await refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: () => credentialsApi.remove(credential.provider),
    onSuccess: async () => {
      setSaved(false);
      setError(null);
      await refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="border-t border-border py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-body text-text-primary">{credential.provider}</span>
        {credential.configured ? (
          // The hint is the runner's, and it is all we have: this UI cannot show a key
          // even to itself — no route serves one back.
          <span className="flex items-center gap-1.5 text-meta text-text-secondary">
            <svg viewBox="0 0 14 14" width={13} height={13} aria-hidden="true" className="text-pass">
              <path
                d="M2.5 7.5l3 3 6-7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Configured
            {credential.hint && <span className="font-mono">· {credential.hint}</span>}
          </span>
        ) : (
          <span className="text-meta text-text-secondary">Not configured</span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          {credential.provider} API key
        </label>
        <input
          id={inputId}
          // A password field: the key is not shown while typing, and browsers keep
          // password inputs out of autofill history unless the user asks.
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
            setSaved(false);
          }}
          placeholder={credential.configured ? 'Replace the stored key' : 'Paste the API key'}
          className="min-w-0 flex-1 rounded-control border border-border bg-surface px-3 py-1.5 font-mono text-body text-text-primary placeholder:font-sans placeholder:text-text-secondary focus:border-accent focus:outline-none"
        />
        <Button
          variant="primary"
          disabled={draft.trim().length === 0 || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {credential.configured && (
          <Button
            variant="secondary"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? 'Removing…' : 'Remove'}
          </Button>
        )}
      </div>

      {error && (
        // Amber, not red (D14): a rejected key is a warning to resolve.
        <p role="alert" className="mt-2 text-meta text-warn">
          {error}
        </p>
      )}
      {saved && !error && (
        <p role="status" className="mt-2 text-meta text-text-secondary">
          Key saved to the runner. It is stored there, not in this browser, and this field
          never keeps it.
        </p>
      )}
    </div>
  );
}

/** Renders nothing at all when the runner advertises no credential capability. */
export function ProviderCredentials() {
  const credentials = useQuery({
    queryKey: CREDENTIALS_QUERY_KEY,
    queryFn: () => credentialsApi.fetchCapability(),
    retry: false,
  });
  const providers = providersOrNull(credentials.data);
  if (!providers || providers.length === 0) return null;

  return (
    <section className="border-t border-border pt-8">
      <h2 className="text-body font-semibold text-text-primary">Model provider</h2>
      <p className="mt-1 max-w-prose text-meta text-text-secondary">
        API keys the runner uses to reach a model provider. Keys are sent to the runner and
        held there — Boardex never stores one in this browser, and no route serves one
        back, so only the last few characters are ever shown.
      </p>
      <div className="mt-4">
        {providers.map((credential) => (
          <ProviderRow key={credential.provider} credential={credential} />
        ))}
      </div>
    </section>
  );
}
