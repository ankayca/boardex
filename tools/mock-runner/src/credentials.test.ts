// The write-only provider-credential store (mock-prototyped, §10.5 proposal —
// docs/decisions.md 2026-07-28). The HTTP surface is pinned in server.test.ts; this
// covers the store's own rules, above all the ones that keep key material in.
import { describe, expect, it } from 'vitest';
import { CredentialStore, maskKey, MOCK_PROVIDERS } from './credentials';

const KEY = 'sk-or-v1-0123456789abcdef92a4';

describe('maskKey', () => {
  it('reveals at most the last four characters', () => {
    expect(maskKey(KEY)).toBe('…92a4');
    expect(maskKey(KEY)).not.toContain('0123456789');
    expect(KEY).toContain(maskKey(KEY).slice(1)); // the tail is real, not invented
  });

  it('reveals NOTHING of a short key — four characters would be most of it', () => {
    expect(maskKey('abc1234')).toBe('…'); // 7 chars: below the floor
    expect(maskKey('')).toBe('…');
  });

  it('pins the floor exactly: 8 characters is the first key that earns a hint', () => {
    // The boundary is the whole rule — off by one here either withholds a harmless
    // hint or reveals half of a short key.
    expect(maskKey('1234567')).toBe('…'); // 7
    expect(maskKey('12345678')).toBe('…5678'); // 8, the first with a hint
    expect(maskKey('123456789')).toBe('…6789'); // 9, still the last four
  });
});

describe('CredentialStore', () => {
  it('advertises the provider unconfigured at boot, with no hint', () => {
    expect(new CredentialStore().advertise()).toEqual([
      { provider: 'openrouter', configured: false },
    ]);
  });

  it('boots configured from the env-var seed (MOCK_PROVIDER_KEY), hint only', () => {
    const advertised = new CredentialStore(undefined, KEY).advertise();
    expect(advertised).toEqual([{ provider: 'openrouter', configured: true, hint: '…92a4' }]);
  });

  it('flips to configured on set and back to unconfigured on clear', () => {
    const store = new CredentialStore();
    expect(store.set('openrouter', KEY)).toEqual({ ok: true });
    expect(store.advertise()[0]).toEqual({
      provider: 'openrouter',
      configured: true,
      hint: '…92a4',
    });

    expect(store.clear('openrouter')).toEqual({ ok: true });
    expect(store.advertise()[0]).toEqual({ provider: 'openrouter', configured: false });
    // Idempotent: removing a key that is not there is not an error.
    expect(store.clear('openrouter')).toEqual({ ok: true });
  });

  it('rejects an unknown provider as 404 and a bad key as 400 — identity first', () => {
    const store = new CredentialStore();
    expect(store.set('anthropic', KEY)).toEqual({
      ok: false,
      status: 404,
      error: 'unknown provider',
    });
    // Identity is checked BEFORE the payload: a key at a provider we do not have is a
    // 404 about the route, not a 400 claiming their key was malformed.
    expect(store.set('anthropic', '')).toMatchObject({ status: 404 });
    expect(store.clear('anthropic')).toMatchObject({ status: 404 });

    expect(store.set('openrouter', '')).toEqual({ ok: false, status: 400, error: 'invalid api key' });
    expect(store.set('openrouter', '   ')).toMatchObject({ status: 400 });
    expect(store.set('openrouter', 42)).toMatchObject({ status: 400 });
    expect(store.set('openrouter', undefined)).toMatchObject({ status: 400 });
    expect(store.set(undefined, KEY)).toMatchObject({ status: 404 });
    // Nothing above stored anything.
    expect(store.advertise()[0]).toEqual({ provider: 'openrouter', configured: false });
  });

  it('never puts key material in a rejection message', () => {
    const store = new CredentialStore();
    const rejections = [store.set('anthropic', KEY), store.set('openrouter', ' ')];
    for (const rejection of rejections) {
      expect(JSON.stringify(rejection)).not.toContain(KEY);
    }
  });

  it('exposes NO read-back: advertise() is the whole outward surface', () => {
    const store = new CredentialStore();
    store.set('openrouter', KEY);
    // Presence and a hint — and, structurally, nowhere else for the key to come out:
    // the store carries no getter, and its map is a private field.
    expect(JSON.stringify(store.advertise())).not.toContain(KEY);
    expect(JSON.stringify(store)).not.toContain(KEY);
    expect(Object.keys(store)).toEqual([]);
  });

  it('advertises exactly the openrouter provider — the agent runner default family', () => {
    expect(MOCK_PROVIDERS).toEqual(['openrouter']);
  });
});
