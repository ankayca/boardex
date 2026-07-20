// T6.6 redirect proof: a runtime runner-URL change must reach BOTH the HTTP client
// (the api singleton) and the WS client (the shared global stream). A setting only some
// callers honor is worse than none — so this exercises each consumer path directly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { subscribeGlobal } from './globalStream';
import { resetSettingsMemory, setRunnerUrlOverride, setSidebarCollapsed } from './settings';

afterEach(() => {
  resetSettingsMemory();
  vi.restoreAllMocks();
});

describe('runner URL redirect → HTTP client (api singleton)', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, contractVersion: 'boardex-contract/0.1', runnerKind: 'mock' }),
    } as unknown as Response);
  });

  it('hits the default base, then the overridden base after a runtime change', async () => {
    await api.getHealth();
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      'http://localhost:4319/health',
      expect.anything(),
    );

    setRunnerUrlOverride('http://custom:5555');
    await api.getHealth();
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      'http://custom:5555/health',
      expect.anything(),
    );
  });

  it('the client baseUrl getter reflects the change without reconstruction', () => {
    expect(api.baseUrl).toBe('http://localhost:4319');
    setRunnerUrlOverride('http://custom:5555');
    expect(api.baseUrl).toBe('http://custom:5555');
  });
});

describe('runner URL redirect → WS client (global stream)', () => {
  const opened: string[] = [];
  let originalWebSocket: unknown;

  class FakeWebSocket {
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(url: string) {
      opened.push(url);
    }
    close(): void {}
  }

  beforeEach(() => {
    opened.length = 0;
    originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  });

  it('reconnects the global socket to the new ws base when the URL changes', () => {
    const unsubscribe = subscribeGlobal(() => {});
    expect(opened).toEqual(['ws://localhost:4319/ws?global=1']);

    setRunnerUrlOverride('http://custom:5555');
    expect(opened).toEqual([
      'ws://localhost:4319/ws?global=1',
      'ws://custom:5555/ws?global=1', // torn down and reconnected against the new base
    ]);

    unsubscribe();
  });

  it('leaves a healthy socket alone when an unrelated setting changes', () => {
    const unsubscribe = subscribeGlobal(() => {});
    expect(opened).toHaveLength(1);

    // A setting that GENUINELY emits (sidebar collapse notifies every subscriber,
    // including globalStream's) must not cycle the socket — globalStream's
    // base-comparison guard is what holds it at one open. Delete that guard and this
    // reconnects to 2, so the assertion proves the guard, not a silent no-op.
    setSidebarCollapsed(true);
    expect(opened).toHaveLength(1);

    // And a no-op empty-override change is likewise inert.
    setRunnerUrlOverride('');
    expect(opened).toHaveLength(1);

    unsubscribe();
  });
});
