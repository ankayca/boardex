// Provider credentials, client side (PUT /credentials, DELETE /credentials/{provider},
// and the `credentials` advertisement on GET /health).
//
// These routes are NOT in packages/contract — they are mock-prototyped and stand as a
// §10.5 proposal to the backend owner (docs/decisions.md, 2026-07-28). So they live
// here rather than in lib/api (the typed client over the CONTRACT command API), exactly
// as the Quick Start path probe does, and they are FEATURE-DETECTED: a runner that
// advertises no `credentials` on /health has no credential surface in this UI at all.
// An absent capability is a missing feature, never an assumed one.
//
// SECRETS DISCIPLINE — the key is PASS-THROUGH and nothing more. It arrives from a form
// field, goes out on one PUT, and is gone: it is never written to localStorage or
// sessionStorage, never to the module-memory settings store (lib/settings — whose whole
// purpose is to be readable by the app), never into a query cache, and never logged.
// The ONLY credential material this module ever holds is the runner's masked hint.
import { z } from 'zod';
import { getRunnerHttpBase } from './config';
import { providerForModel } from './providerForModel';

/** Presence and a masked hint, per provider — the whole of what a runner advertises. */
export const ProviderCredentialSchema = z.object({
  provider: z.string(),
  configured: z.boolean(),
  /** A masked tail of the stored key (e.g. "…92a4"). Never key material. */
  hint: z.string().optional(),
});

export type ProviderCredential = z.infer<typeof ProviderCredentialSchema>;

// /health carries the contract fields too; only `credentials` is read here, and the
// contract-shaped ones stay lib/api's business (its parse strips this field, which is
// precisely why this module does its own read).
const CredentialsHealthSchema = z.object({
  credentials: z.array(ProviderCredentialSchema).optional(),
});

/**
 * `unsupported` is the feature-detection answer — this runner advertises no credential
 * capability. It is NOT an error state: the runner may well have keys in its
 * environment, we simply have no in-product way to see or set them.
 */
export type CredentialsCapability =
  | { status: 'advertised'; providers: ProviderCredential[] }
  | { status: 'unsupported' };

/** What went wrong on a write, as copy the user can act on. Never echoes the key. */
export class CredentialError extends Error {}

function base(): string {
  return getRunnerHttpBase().replace(/\/+$/, '');
}

async function fetchCapability(): Promise<CredentialsCapability> {
  const res = await fetch(`${base()}/health`);
  if (!res.ok) throw new Error(`GET /health failed with ${res.status}`);
  const { credentials } = CredentialsHealthSchema.parse(await res.json());
  return credentials ? { status: 'advertised', providers: credentials } : { status: 'unsupported' };
}

async function put(provider: string, apiKey: string): Promise<void> {
  const res = await fetch(`${base()}/credentials`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, apiKey }),
  });
  if (res.status === 204) return;
  // Fixed copy per status — the request body is never read back into a message, so a
  // mistyped key cannot travel into an error string and from there onto the screen.
  if (res.status === 404) {
    throw new CredentialError(`The runner does not offer a provider called “${provider}”.`);
  }
  if (res.status === 400) {
    throw new CredentialError('The runner rejected that key — check you pasted the whole value.');
  }
  throw new CredentialError('Could not save the key — check that the runner is online.');
}

async function remove(provider: string): Promise<void> {
  const res = await fetch(`${base()}/credentials/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
  });
  if (res.status === 204) return;
  if (res.status === 404) {
    throw new CredentialError(`The runner does not offer a provider called “${provider}”.`);
  }
  throw new CredentialError('Could not remove the key — check that the runner is online.');
}

/** An object, not bare exports, so tests can spy on the one seam (mirrors lib/api). */
export const credentialsApi = { fetchCapability, put, remove };

/** The one query key both credential surfaces share, so a save refreshes them together. */
export const CREDENTIALS_QUERY_KEY = ['credentials'] as const;

/**
 * The advertised providers, or null when the capability is absent / not yet known /
 * unreachable. Callers render NOTHING on null — never a placeholder, never a warning.
 */
export function providersOrNull(
  capability: CredentialsCapability | undefined,
): ProviderCredential[] | null {
  return capability?.status === 'advertised' ? capability.providers : null;
}

/**
 * The advertised provider the given model needs a key for — but only when that provider
 * is reported UNCONFIGURED. Pure, and null means "say nothing": no capability, a model
 * whose provider does not derive (see providerForModel), a provider this runner never
 * named, or one that already has a key all map to the same silence. The composer's
 * pre-flight is a warning about something we KNOW is missing, never a guess.
 */
export function unconfiguredProviderFor(
  model: string | undefined,
  providers: ProviderCredential[] | null,
): ProviderCredential | null {
  const provider = providerForModel(model);
  if (!provider || !providers) return null;
  const match = providers.find((c) => c.provider.toLowerCase() === provider);
  return match && !match.configured ? match : null;
}
