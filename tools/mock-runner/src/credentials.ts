// Provider credentials — the write-only key store behind PUT /credentials,
// DELETE /credentials/{provider}, and /health's `credentials` advertisement.
//
// These routes are MOCK-PROTOTYPED and deliberately NOT in packages/contract: they are
// a §10.5 proposal to the backend owner, not a shipped contract addition (see
// docs/decisions.md, 2026-07-28). The UI therefore feature-detects them — a runner that
// does not implement them advertises no `credentials` on /health and the Settings
// section simply does not exist.
//
// SECRETS DISCIPLINE — this is the whole design, not a precaution bolted on:
//
//  1. WRITE-ONLY. There is deliberately NO read-back route, and none may be added.
//     `advertise()` is the ONLY thing this module exposes to the outside world, and it
//     returns presence plus a masked hint — never key material. A GET therefore cannot
//     leak what a PUT stored, because there is nothing that serves it.
//  2. The key never reaches an event, an artifact, a log line, or an error body. The
//     store is not wired to the event log at all, and every rejection below answers
//     with a FIXED string that never echoes the request.
//  3. Storage is module memory: it dies with the process. Honest for v0 — no file, no
//     env write, nothing that outlives the runner and nothing to leave behind on disk.
//
// The env-var seed mirrors the real runner's semantics (keys are provider-standard env
// vars read by LiteLLM at call time — docs/decisions.md, 2026-07-13): a runner booted
// with a key in the environment is already configured, and the UI must see that rather
// than offer to set a key that is in fact already set.

/** What /health advertises per provider: presence and a masked hint, never the key. */
export interface ProviderCredentialStatus {
  provider: string;
  configured: boolean;
  /** Masked tail of the stored key (see maskKey) — present only when configured. */
  hint?: string;
}

export type CredentialResult =
  | { ok: true }
  | { ok: false; status: 400 | 404; error: string };

// The hint reveals at most the last four characters, and only when the key is long
// enough that four characters are a negligible fraction of it. A short key would have
// its tail be most of its material, so it masks to a bare ellipsis: still a truthful
// "something is set here", with nothing recoverable in it.
const HINT_MIN_KEY_LENGTH = 8;
const HINT_TAIL_LENGTH = 4;

export function maskKey(key: string): string {
  return key.length >= HINT_MIN_KEY_LENGTH ? `…${key.slice(-HINT_TAIL_LENGTH)}` : '…';
}

/**
 * The providers this runner can hold a key for. One entry for the mock — the agent
 * runner's own default model family is `openrouter/...` (docs/decisions.md 2026-07-13),
 * so openrouter is the provider a real key would actually be needed for.
 */
export const MOCK_PROVIDERS: readonly string[] = ['openrouter'];

export class CredentialStore {
  // provider -> key. Module memory only; never serialized, never logged.
  readonly #keys = new Map<string, string>();
  readonly #providers: readonly string[];

  constructor(providers: readonly string[] = MOCK_PROVIDERS, envKey?: string | undefined) {
    this.#providers = providers;
    // Env-var simulation: a booted-with-a-key runner reports configured from the start.
    const first = providers[0];
    if (envKey && first) this.#keys.set(first, envKey);
  }

  /** The ONLY outward view of this store: presence + hint, per advertised provider. */
  advertise(): ProviderCredentialStatus[] {
    return this.#providers.map((provider) => {
      const key = this.#keys.get(provider);
      return key === undefined
        ? { provider, configured: false }
        : { provider, configured: true, hint: maskKey(key) };
    });
  }

  /**
   * Store a key for an advertised provider. Identity is checked before the payload: a
   * key posted at a provider this runner does not have is a 404 about the ROUTE, and
   * answering 400 there would tell the caller their key was malformed when it was not.
   */
  set(provider: unknown, apiKey: unknown): CredentialResult {
    if (typeof provider !== 'string' || !this.#providers.includes(provider)) {
      // Every rejection string below is FIXED — it never echoes the request body, so a
      // mistyped key cannot end up in an error response, a proxy log, or a UI toast.
      return { ok: false, status: 404, error: 'unknown provider' };
    }
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      return { ok: false, status: 400, error: 'invalid api key' };
    }
    this.#keys.set(provider, apiKey.trim());
    return { ok: true };
  }

  /** Remove a provider's key. Idempotent: an advertised provider with no key is 204. */
  clear(provider: string): CredentialResult {
    if (!this.#providers.includes(provider)) {
      return { ok: false, status: 404, error: 'unknown provider' };
    }
    this.#keys.delete(provider);
    return { ok: true };
  }
}
