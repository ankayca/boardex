// The live bench snapshot for every readiness surface (BIBLE §7.1/§7.2): primarily
// the runner.status snapshot mirrored into the bench store from the global WS; GET
// /bench fills the gap before the first snapshot lands (fresh page load racing the
// socket).
import { useQuery } from '@tanstack/react-query';
import type { BenchStatus } from '@boardex/contract';
import { api } from './api';
import { useBenchStore } from './benchStore';

export function useBenchStatus(): BenchStatus | null {
  const live = useBenchStore((state) => state.bench);
  const fallback = useQuery({
    queryKey: ['bench'],
    queryFn: () => api.getBench(),
    enabled: live === null,
    retry: false,
  });
  return live ?? fallback.data ?? null;
}
