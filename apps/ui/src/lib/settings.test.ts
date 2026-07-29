// Runtime settings + runner-URL precedence (T6.6). Persistence is module memory, so
// these assertions are about the in-session value and the user > env > default order
// that lib/config resolves — the same order the api singleton and both WS clients read.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addRecentRepoPath,
  getRecentRepoPaths,
  getRunnerUrlOverride,
  getSidebarCollapsed,
  RECENT_REPO_PATH_LIMIT,
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

  it('an empty VITE_RUNNER_URL means same-origin: relative HTTP and WS bases', () => {
    // How the packaged app ships (`boardex up`): the runner serves the built UI
    // from its own origin, so the bundle is built with VITE_RUNNER_URL="" and
    // every request is relative. An empty base is the point, not a misconfiguration.
    vi.stubEnv('VITE_RUNNER_URL', '');
    expect(getEnvRunnerHttpBase()).toBe('');
    expect(getRunnerHttpBase()).toBe('');
    expect(getRunnerWsBase()).toBe('');
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

// Quick Start v0: the remembered firmware paths. Same module memory as everything else
// here — a session-lived convenience, never a stored record of the user's disk.
describe('recent repo paths', () => {
  it('starts empty and remembers most-recent-first', () => {
    expect(getRecentRepoPaths()).toEqual([]);
    addRecentRepoPath('/bench/firmware/a');
    addRecentRepoPath('/bench/firmware/b');
    expect(getRecentRepoPaths()).toEqual(['/bench/firmware/b', '/bench/firmware/a']);
  });

  it('promotes a re-used path instead of repeating it', () => {
    addRecentRepoPath('/bench/firmware/a');
    addRecentRepoPath('/bench/firmware/b');
    addRecentRepoPath('/bench/firmware/a');
    expect(getRecentRepoPaths()).toEqual(['/bench/firmware/a', '/bench/firmware/b']);
  });

  it('trims, ignores blanks, and caps the list', () => {
    addRecentRepoPath('   ');
    expect(getRecentRepoPaths()).toEqual([]);

    addRecentRepoPath('  /bench/firmware/a  ');
    expect(getRecentRepoPaths()).toEqual(['/bench/firmware/a']);

    for (let i = 0; i < RECENT_REPO_PATH_LIMIT + 3; i++) addRecentRepoPath(`/bench/fw/${i}`);
    expect(getRecentRepoPaths()).toHaveLength(RECENT_REPO_PATH_LIMIT);
    expect(getRecentRepoPaths()[0]).toBe(`/bench/fw/${RECENT_REPO_PATH_LIMIT + 2}`);
  });

  it('notifies subscribers, and resets with the rest of the module memory', () => {
    const seen = vi.fn();
    const unsubscribe = subscribeSettings(seen);
    addRecentRepoPath('/bench/firmware/a');
    expect(seen).toHaveBeenCalledTimes(1);
    unsubscribe();

    resetSettingsMemory();
    expect(getRecentRepoPaths()).toEqual([]);
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
