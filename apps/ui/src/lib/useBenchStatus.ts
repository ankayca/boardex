// The live bench snapshot for every readiness surface (BIBLE §7.1/§7.2): primarily
// the runner.status snapshot mirrored into the bench store from the global WS; GET
// /bench fills the gap before the first snapshot lands (fresh page load racing the
// socket) and after the socket drops.
//
// Liveness is enforced here rather than at each call site, so no surface can forget it
// (T4.2 review F1). When the global socket leaves 'open' the snapshot is dropped: a
// device list is a claim about *now*, and a socket that is reconnecting has stopped
// making it. Dropping it re-enables the fallback below, which re-fetches under a fresh
// generation — so what returns is a snapshot that postdates the current connection,
// never the one we happened to be holding when it broke.
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BenchStatus } from '@boardex/contract';
import { api } from './api';
import { useBenchStore } from './benchStore';
import { subscribeGlobalStatus } from './globalStream';

export function useBenchStatus(): BenchStatus | null {
  const live = useBenchStore((state) => state.bench);
  const generation = useBenchStore((state) => state.generation);
  const clear = useBenchStore((state) => state.clear);

  useEffect(
    () => subscribeGlobalStatus((status) => (status === 'open' ? undefined : clear())),
    [clear],
  );

  const fallback = useQuery({
    // Generation-scoped: a response cached under a previous connection is a different
    // query, so it can never be served for this one.
    queryKey: ['bench', generation],
    queryFn: () => api.getBench(),
    enabled: live === null,
    retry: false,
  });
  return live ?? fallback.data ?? null;
}
