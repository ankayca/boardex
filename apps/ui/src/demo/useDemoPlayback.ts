// The demo playback engine (T6.5). Owns a DEDICATED run-store instance (never the app
// singleton) and feeds the recorded events into it one at a time, paced by the
// compressed delayMs schedule — "driven through the run store exactly like a live
// stream", so reduceRun and every workspace surface behave identically to a real run.
//
// This module imports no api client: the demo cannot talk to a runner. The workspace's
// commands come from a local RunCommands (see makeDemoCommands) whose stop exits the
// demo and whose approve fast-forwards to the recording's own resolution — implemented
// here as advanceToApprovalResolution.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isKnownEvent, type RunView } from '@boardex/contract';
import { createRunStore } from '../lib/runStore';
import { DEMO_ENTRIES, DEMO_RUN_ID, type DemoEntry } from './data/demoRun';
import { compressDelays } from './pace';
import { rebaseEntries } from './rebase';

export type DemoPlaybackStatus = 'playing' | 'paused' | 'ended';

export interface DemoPlayback {
  /** The reduced view of everything ingested so far; null before run.created lands. */
  view: RunView | null;
  status: DemoPlaybackStatus;
  /** Index of the next event to ingest — how far playback has progressed. */
  cursor: number;
  total: number;
  pause: () => void;
  resume: () => void;
  /** Ingest every remaining event at once and settle at the end. */
  skipToEnd: () => void;
  /** Fast-forward to (and through) the recorded resolution of an approval. */
  advanceToApprovalResolution: (approvalId: string) => void;
}

export function useDemoPlayback(source: readonly DemoEntry[] = DEMO_ENTRIES): DemoPlayback {
  // One store for the life of the hook; the initializer runs once per mount.
  const storeRef = useRef<ReturnType<typeof createRunStore> | null>(null);
  if (storeRef.current === null) storeRef.current = createRunStore();
  const store = storeRef.current;

  // Rebase the recording to start now (§5.6, like the mock) so elapsed reads seconds,
  // not the authored-time gap. Computed once — a stable base for the hook's life.
  const entries = useMemo(() => rebaseEntries(source, Date.now()), [source]);
  const pacing = useMemo(() => compressDelays(entries.map((entry) => entry.delayMs)), [entries]);
  const [cursor, setCursor] = useState(0);
  const [paused, setPaused] = useState(false);

  const view = store((state) => state.runs[DEMO_RUN_ID]?.view ?? null);
  const atEnd = cursor >= entries.length;

  // Schedule the next event. Keyed on the cursor, so exactly one timer is live at a
  // time; ingest is idempotent by seq, so a StrictMode double-mount can't double-play.
  useEffect(() => {
    if (paused || atEnd) return;
    const entry = entries[cursor]!;
    const timer = window.setTimeout(() => {
      store.getState().ingest(DEMO_RUN_ID, entry.event);
      setCursor((current) => current + 1);
    }, pacing[cursor] ?? 0);
    return () => window.clearTimeout(timer);
  }, [cursor, paused, atEnd, entries, pacing, store]);

  const skipToEnd = useCallback(() => {
    store.getState().ingestMany(
      DEMO_RUN_ID,
      entries.slice(cursor).map((entry) => entry.event),
    );
    setCursor(entries.length);
  }, [cursor, entries, store]);

  const advanceToApprovalResolution = useCallback(
    (approvalId: string) => {
      let target = -1;
      for (let i = cursor; i < entries.length; i++) {
        const event = entries[i]!.event;
        if (
          isKnownEvent(event) &&
          event.type === 'approval.resolved' &&
          event.payload.approvalId === approvalId
        ) {
          target = i;
          break;
        }
      }
      if (target === -1) return; // already past it — playback will resolve on its own
      store.getState().ingestMany(
        DEMO_RUN_ID,
        entries.slice(cursor, target + 1).map((entry) => entry.event),
      );
      setCursor(target + 1);
      setPaused(false);
    },
    [cursor, entries, store],
  );

  const pause = useCallback(() => setPaused(true), []);
  const resume = useCallback(() => setPaused(false), []);

  const status: DemoPlaybackStatus = atEnd ? 'ended' : paused ? 'paused' : 'playing';

  return {
    view,
    status,
    cursor,
    total: entries.length,
    pause,
    resume,
    skipToEnd,
    advanceToApprovalResolution,
  };
}
