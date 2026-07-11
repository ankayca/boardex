// Latest bench snapshot from the global WS runner.status event (BIBLE §5.2), and the
// liveness rule that keeps it honest.
//
// A BenchStatus is only as true as the connection that delivered it. When the global
// socket leaves 'open' the snapshot stops being evidence of anything — the analyzer
// may have been unplugged while we were not listening — so it is dropped rather than
// left on screen. `generation` counts those drops: useBenchStatus keys its GET /bench
// fallback on it, so a response fetched under an older connection can never be served
// as if it described the current one.
import { create } from 'zustand';
import type { BenchStatus } from '@boardex/contract';

export interface BenchStoreState {
  bench: BenchStatus | null;
  /** Bumped on every clear; scopes the HTTP fallback to the current connection. */
  generation: number;
  setBench: (bench: BenchStatus) => void;
  clear: () => void;
}

export const useBenchStore = create<BenchStoreState>()((set) => ({
  bench: null,
  generation: 0,
  setBench: (bench) => set({ bench }),
  // Always bumps, even with no snapshot in hand: the stale thing may be the HTTP
  // fallback's cached response rather than the WS snapshot, and only the generation
  // invalidates that. Every consumer reads the same counter, so the duplicate calls
  // one status change produces across subscribers are harmless.
  clear: () => set((state) => ({ bench: null, generation: state.generation + 1 })),
}));
