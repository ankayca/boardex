// Bench readiness for the composer (BIBLE §7.2): primarily the live runner.status
// snapshot mirrored into the bench store from the global WS; GET /bench fills the
// gap before the first snapshot lands (fresh page load racing the socket).
import { useQuery } from '@tanstack/react-query';
import type { BenchStatus } from '@boardex/contract';
import { api } from '../../lib/api';
import { useBenchStore } from '../../lib/benchStore';

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
