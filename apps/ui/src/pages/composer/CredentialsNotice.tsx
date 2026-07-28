// The composer's credentials pre-flight (§7.2). The pain it kills: with no API key on
// the runner, a run is created, plans, and dies with the provider's error buried in the
// agent log. This says so before the click, where it is cheap to fix.
//
// ADVISORY, NEVER A GATE: Create Run Plan stays enabled beside it. The runner may hold
// a key in its environment without advertising it, so blocking would claim knowledge we
// do not have — the same rule the bench references follow (§7.2: a warning composing
// still allows, never an assumed anything).
//
// It renders ONLY when all three are true: the runner advertises a credential
// capability, the selected model derives a provider (lib/providerForModel — the explicit
// prefix form only), and that provider is advertised as unconfigured. Any silence in
// that chain — no capability, a bare model string, a provider the runner never named —
// renders nothing, because we do not know that a key is missing.
//
// D14: amber. A missing key is a warning to resolve, not a run that failed.
// The decision of WHETHER to render lives in lib/credentials (unconfiguredProviderFor);
// this file renders, and nothing else.
import { Link, useLocation } from 'react-router-dom';

export interface CredentialsNoticeProps {
  provider: string;
  /** Handed to Settings so the way back — and the draft it holds — survives the trip. */
  returnState: unknown;
}

export function CredentialsNotice({ provider, returnState }: CredentialsNoticeProps) {
  const { pathname } = useLocation();
  return (
    <p
      role="status"
      className="rounded-card border border-warn bg-warn-bg px-4 py-3 text-meta text-warn"
    >
      No API key configured for <span className="font-mono">{provider}</span> — the agent needs
      one to run.{' '}
      <Link
        to="/settings"
        state={{ returnTo: pathname, label: 'Back to your task', state: returnState }}
        className="font-medium underline underline-offset-2"
      >
        Add it in Settings →
      </Link>
    </p>
  );
}
