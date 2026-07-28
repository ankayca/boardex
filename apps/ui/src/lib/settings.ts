// Runtime user settings (T6.6), held in MODULE MEMORY — the same mechanism the
// sidebar collapse (T6.1b) and the demo tour-seen flag (T6.5) already use: a value
// survives navigation within a session and resets on reload; there is NO storage.
// This is deliberate — the T6.6 constraint is to match the pattern this codebase
// established, not to introduce a new storage path (localStorage/IndexedDB).
//
// Two settings live here:
//   • runnerUrlOverride — a user-set runner base URL that outranks the env default.
//     Consumed via lib/config's getRunnerHttpBase/getRunnerWsBase, which every HTTP
//     and WS caller resolves against, so a change re-points the whole app (§T6.6).
//   • sidebarCollapsed  — the collapse-by-default preference, folded in from the
//     Sidebar's former private module flag so there is a single source of truth.
//   • recentRepoPaths   — Quick Start's recently used firmware paths (v0), offered as
//     tappable chips so the second run against a board is not a retype. Same module
//     memory: a session-lived convenience, never a stored record of the user's disk.
import { useSyncExternalStore } from 'react';

let runnerUrlOverride: string | null = null;
let sidebarCollapsed = false;
let recentRepoPaths: readonly string[] = [];

/** How many Quick Start paths are remembered — a chip row, not a history. */
export const RECENT_REPO_PATH_LIMIT = 5;

// A monotonic tick bumped on ANY settings change (drives useSyncExternalStore), plus a
// dedicated runner-URL tick so the run stream only reconnects when the URL actually
// changes — never on an unrelated toggle like sidebar collapse.
let version = 0;
let runnerUrlVersion = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function settingsVersion(): number {
  return version;
}

export function runnerUrlVersionValue(): number {
  return runnerUrlVersion;
}

/** The user's runner-URL override, or null when none is set (env/default apply). */
export function getRunnerUrlOverride(): string | null {
  return runnerUrlOverride;
}

/**
 * Set — or clear, with '' / null — the runner-URL override. Trailing slashes are
 * trimmed so the value composes with the api/ws path builders exactly as the env base
 * does. A no-op change notifies no one, so an idempotent Save never forces a reconnect.
 */
export function setRunnerUrlOverride(value: string | null): void {
  const trimmed = (value ?? '').trim().replace(/\/+$/, '');
  const next = trimmed.length > 0 ? trimmed : null;
  if (next === runnerUrlOverride) return;
  runnerUrlOverride = next;
  runnerUrlVersion += 1;
  emit();
}

export function getSidebarCollapsed(): boolean {
  return sidebarCollapsed;
}

export function setSidebarCollapsed(value: boolean): void {
  if (value === sidebarCollapsed) return;
  sidebarCollapsed = value;
  emit();
}

/** Quick Start's remembered firmware paths, most recent first (v0). */
export function getRecentRepoPaths(): readonly string[] {
  return recentRepoPaths;
}

/**
 * Remember a path Quick Start actually created a run with. Most recent first, no
 * duplicates (re-using a path promotes it rather than repeating it), capped at
 * RECENT_REPO_PATH_LIMIT. Blank input is ignored — there is nothing to remember.
 */
export function addRecentRepoPath(path: string): void {
  const trimmed = path.trim();
  if (trimmed.length === 0) return;
  const next = [trimmed, ...recentRepoPaths.filter((entry) => entry !== trimmed)].slice(
    0,
    RECENT_REPO_PATH_LIMIT,
  );
  recentRepoPaths = next;
  emit();
}

/** Test seam — restore settings to their defaults (mirrors demo/Tour's resetTourMemory). */
export function resetSettingsMemory(): void {
  const hadOverride = runnerUrlOverride !== null;
  runnerUrlOverride = null;
  sidebarCollapsed = false;
  recentRepoPaths = [];
  if (hadOverride) runnerUrlVersion += 1;
  emit();
}

/** React binding: components re-render on any settings change. */
export function useSettingsVersion(): number {
  return useSyncExternalStore(subscribeSettings, settingsVersion, settingsVersion);
}

/**
 * React binding scoped to runner-URL changes: an effect keyed on this re-runs only
 * when the URL changed, so useRunStream reconnects on a URL swap but not on, say, a
 * sidebar-collapse toggle.
 */
export function useRunnerUrlVersion(): number {
  return useSyncExternalStore(subscribeSettings, runnerUrlVersionValue, runnerUrlVersionValue);
}
