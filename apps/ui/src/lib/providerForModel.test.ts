// Provider-for-model derivation (lib/providerForModel): the explicit prefix form only.
import { describe, expect, it } from 'vitest';
import { providerForModel } from './providerForModel';

describe('providerForModel', () => {
  it('reads the provider prefix, lowercased', () => {
    // The runner's own default model (docs/decisions.md 2026-07-13).
    expect(providerForModel('openrouter/anthropic/claude-sonnet-4.6')).toBe('openrouter');
    expect(providerForModel('anthropic/claude-sonnet-4-6')).toBe('anthropic');
    expect(providerForModel('OpenRouter/anthropic/claude-sonnet-4.6')).toBe('openrouter');
    expect(providerForModel(' openrouter /x')).toBe('openrouter');
  });

  it('derives NOTHING from a bare model string — resolving it needs runner-side tables', () => {
    // litellm resolves `claude-sonnet-4-6` to provider anthropic; the browser has no
    // such table, and a substring guess would be wrong on both directions (it would
    // miss this one and false-positive on a third-party model named after one).
    expect(providerForModel('claude-sonnet-4-6')).toBeUndefined();
    expect(providerForModel('mock-model')).toBeUndefined();
    expect(providerForModel('gpt-4o')).toBeUndefined();
  });

  it('derives nothing from an absent or malformed string', () => {
    expect(providerForModel(undefined)).toBeUndefined();
    expect(providerForModel('')).toBeUndefined();
    expect(providerForModel('/leading-slash')).toBeUndefined();
    expect(providerForModel('   /x')).toBeUndefined();
  });
});
