// Runtime settings + runner-URL precedence (T6.6). Persistence is module memory, so
// these assertions are about the in-session value and the user > env > default order
// that lib/config resolves — the same order the api singleton and both WS clients read.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getRunnerUrlOverride,
  getSidebarCollapsed,
  resetSettingsMemory,
  runnerUrlVersionValue,
  setRunnerUrlOverride,
  setSidebarCollapsed,
  settingsVersion,
  subscribeSettings,
} from './settings';
import { getEnvRunnerHttpBase, getRunnerHttpBase, getRunnerWsBase } from './config';

afterEach(() => {
  resetSettingsMemory();
  vi.unstubAllEnvs();
});

describe('runner URL precedence — user > env > default', () => {
  it('uses the built-in §5.6 default when neither an override nor env is set', () => {
    expect(getRunnerUrlOverride()).toBeNull();
    expect(getEnvRunnerHttpBase()).toBe('http://localhost:4319');
    expect(getRunnerHttpBase()).toBe('http://localhost:4319');
  });

  it('env (VITE_RUNNER_URL) beats the default', () => {
    vi.stubEnv('VITE_RUNNER_URL', 'http://runner.example:9000');
    expect(getEnvRunnerHttpBase()).toBe('http://runner.example:9000');
    expect(getRunnerHttpBase()).toBe('http://runner.example:9000');
  });

  it('a user override beats env; clearing it falls back to env (env wins when unset)', () => {
    vi.stubEnv('VITE_RUNNER_URL', 'http://runner.example:9000');
    setRunnerUrlOverride('http://custom:1234');
    expect(getRunnerHttpBase()).toBe('http://custom:1234');

    setRunnerUrlOverride(''); // empty clears the override
    expect(getRunnerUrlOverride()).toBeNull();
    expect(getRunnerHttpBase()).toBe('http://runner.example:9000');
  });

  it('trims whitespace and trailing slashes on the stored override', () => {
    setRunnerUrlOverride('  http://custom:1234//  ');
    expect(getRunnerUrlOverride()).toBe('http://custom:1234');
  });

  it('derives the ws base from the EFFECTIVE http base', () => {
    expect(getRunnerWsBase()).toBe('ws://localhost:4319');
    setRunnerUrlOverride('https://runner.example:9000');
    expect(getRunnerWsBase()).toBe('wss://runner.example:9000');
  });
});

describe('settings change notifications', () => {
  it('bumps the runner-URL version only when the URL actually changes', () => {
    const before = runnerUrlVersionValue();
    setRunnerUrlOverride('http://custom:1234');
    expect(runnerUrlVersionValue()).toBe(before + 1);

    // A no-op set (same normalized value) must not bump — no needless reconnect.
    setRunnerUrlOverride('http://custom:1234/');
    expect(runnerUrlVersionValue()).toBe(before + 1);
  });

  it('does NOT bump the runner-URL version for an unrelated setting', () => {
    const before = runnerUrlVersionValue();
    setSidebarCollapsed(true);
    expect(getSidebarCollapsed()).toBe(true);
    expect(runnerUrlVersionValue()).toBe(before); // sidebar toggle never touches the URL tick
  });

  it('notifies subscribers on any change and stops after unsubscribe', () => {
    const seen = vi.fn();
    const unsubscribe = subscribeSettings(seen);
    const v0 = settingsVersion();

    setSidebarCollapsed(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(settingsVersion()).toBe(v0 + 1);

    unsubscribe();
    setRunnerUrlOverride('http://custom:1234');
    expect(seen).toHaveBeenCalledTimes(1); // no further calls after unsubscribe
  });
});
