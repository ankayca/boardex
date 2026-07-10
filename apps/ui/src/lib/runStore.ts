// The run state store (BIBLE D5): a Zustand store keyed by runId that holds the
// ordered event stream and a memoized reduceRun() view. This is the ONLY path by
// which the UI derives run state — reconnect, HTTP replay, and live WS all funnel
// through ingest(), and the contract reducer does the deriving.
//
// Events may arrive out of order or duplicated (live vs. replay overlap): the store
// dedupes by seq, keeps the gapless [1..N] prefix, and only re-reduces when that
// prefix grows. A gap parks derivation until the missing seq is filled, so the
// reducer (which throws on gaps) is only ever handed a contiguous stream.
import { create } from 'zustand';
import { reduceRun, type RunView, type WireEvent } from '@boardex/contract';

export interface RunEntry {
  // Every received event, keyed by seq (dedupes duplicates / replay overlap).
  // WireEvent, not Event: an ignored envelope (unknown type, §5.1/T5.0) must fill
  // its seq slot or the prefix below parks on a permanent gap.
  bySeq: Map<number, WireEvent>;
  // The gapless, seq-ordered prefix [1..N]; its length is the last contiguous seq.
  events: WireEvent[];
  // Memoized reduceRun(events); null until seq 1 (run.created) has arrived.
  view: RunView | null;
}

export interface RunStoreState {
  runs: Record<string, RunEntry>;
  ingest: (runId: string, event: WireEvent) => void;
  ingestMany: (runId: string, events: readonly WireEvent[]) => void;
  /** Highest gapless seq held for a run — the afterSeq to request on replay. */
  lastContiguousSeq: (runId: string) => number;
  reset: (runId: string) => void;
  resetAll: () => void;
}

const emptyEntry = (): RunEntry => ({ bySeq: new Map(), events: [], view: null });

// Fold one event into an entry. Returns the same entry reference (a no-op) when the
// seq was already seen — that referential stability is what makes ingest idempotent
// and keeps the memoized view from recomputing on duplicates.
function applyEvent(entry: RunEntry, event: WireEvent): RunEntry {
  if (entry.bySeq.has(event.seq)) return entry;
  const bySeq = new Map(entry.bySeq);
  bySeq.set(event.seq, event);

  const events = entry.events.slice();
  let nextSeq = events.length + 1;
  while (bySeq.has(nextSeq)) {
    events.push(bySeq.get(nextSeq) as WireEvent);
    nextSeq++;
  }

  const grew = events.length > entry.events.length;
  return { bySeq, events, view: grew ? reduceRun(events) : entry.view };
}

export function createRunStore() {
  return create<RunStoreState>()((set, get) => ({
    runs: {},
    ingest: (runId, event) =>
      set((state) => {
        const prev = state.runs[runId] ?? emptyEntry();
        const next = applyEvent(prev, event);
        if (next === prev) return state; // duplicate seq: no-op
        return { runs: { ...state.runs, [runId]: next } };
      }),
    ingestMany: (runId, events) =>
      set((state) => {
        const prev = state.runs[runId] ?? emptyEntry();
        let next = prev;
        for (const event of events) next = applyEvent(next, event);
        if (next === prev) return state;
        return { runs: { ...state.runs, [runId]: next } };
      }),
    lastContiguousSeq: (runId) => get().runs[runId]?.events.length ?? 0,
    reset: (runId) =>
      set((state) => {
        if (!state.runs[runId]) return state;
        const runs = { ...state.runs };
        delete runs[runId];
        return { runs };
      }),
    resetAll: () => set({ runs: {} }),
  }));
}

export type RunStore = ReturnType<typeof createRunStore>;

// App-wide singleton — the one store the UI reads run state from.
export const useRunStore: RunStore = createRunStore();

/** Selector hook for a run's memoized reduced view (null until run.created arrives). */
export const useRunView = (runId: string): RunView | null =>
  useRunStore((state) => state.runs[runId]?.view ?? null);
