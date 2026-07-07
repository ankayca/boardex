// Latest bench snapshot from the global WS runner.status event (BIBLE §5.2). The
// top bar's runner pill is driven primarily by the /health poll; this store holds
// the richer BenchStatus (device list) for the readiness surfaces built in later
// sprints (§7.1/§7.2).
import { create } from 'zustand';
import type { BenchStatus } from '@boardex/contract';

export interface BenchStoreState {
  bench: BenchStatus | null;
  setBench: (bench: BenchStatus) => void;
  clear: () => void;
}

export const useBenchStore = create<BenchStoreState>()((set) => ({
  bench: null,
  setBench: (bench) => set({ bench }),
  clear: () => set({ bench: null }),
}));
