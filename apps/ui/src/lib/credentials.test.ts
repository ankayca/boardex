// The pure half of lib/credentials: what the composer's pre-flight decides to say.
// Silence is the answer to every unknown — a warning is only ever raised about a
// provider the runner itself named and reported unconfigured.
import { describe, expect, it } from 'vitest';
import {
  providersOrNull,
  unconfiguredProviderFor,
  type ProviderCredential,
} from './credentials';

const AGENT_MODEL = 'openrouter/anthropic/claude-sonnet-4.6';
const missing: ProviderCredential = { provider: 'openrouter', configured: false };
const present: ProviderCredential = { provider: 'openrouter', configured: true, hint: '…92a4' };

describe('providersOrNull', () => {
  it('is null for an unsupported capability or none at all', () => {
    expect(providersOrNull({ status: 'unsupported' })).toBeNull();
    expect(providersOrNull(undefined)).toBeNull();
  });

  it('is the advertised list when the runner advertises one', () => {
    expect(providersOrNull({ status: 'advertised', providers: [missing] })).toEqual([missing]);
  });
});

describe('unconfiguredProviderFor', () => {
  it('names the provider when it is advertised and has no key', () => {
    expect(unconfiguredProviderFor(AGENT_MODEL, [missing])).toEqual(missing);
    // Advertised names are matched case-insensitively against the derived prefix.
    expect(unconfiguredProviderFor('OpenRouter/x', [missing])).toEqual(missing);
  });

  it('says nothing once that provider is configured', () => {
    expect(unconfiguredProviderFor(AGENT_MODEL, [present])).toBeNull();
  });

  it('says nothing without a capability, a model, or a derivable provider', () => {
    expect(unconfiguredProviderFor(AGENT_MODEL, null)).toBeNull();
    expect(unconfiguredProviderFor(undefined, [missing])).toBeNull();
    // A bare model name resolves runner-side only — we do not know what it needs.
    expect(unconfiguredProviderFor('mock-model', [missing])).toBeNull();
  });

  it('says nothing about a provider this runner never advertised', () => {
    // The runner offers openrouter; the model wants anthropic. It may hold that key in
    // its environment without advertising it — warning here would be a guess.
    expect(unconfiguredProviderFor('anthropic/claude-sonnet-4-6', [missing])).toBeNull();
    expect(unconfiguredProviderFor(AGENT_MODEL, [])).toBeNull();
  });
});
