// Shared artifact-content plumbing for the evidence content tabs (§7.4).
// Every tab fetches its artifact's raw text by reference (GET /artifacts/{id},
// D4), caches it as immutable (§4), and walks the same three fail-closed gates
// before rendering: loading, fetch error (with retry), unreadable content.
// The tabs keep their own parsers; this owns the fetch and the gate rendering.
import type { ReactNode } from 'react';
import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Artifact } from '@boardex/contract';
import { Button } from '../../design';
import { api } from '../../lib/api';

export function useArtifactContent(artifactId: string | undefined): UseQueryResult<string> {
  return useQuery({
    queryKey: ['artifact-content', artifactId],
    queryFn: artifactId ? () => api.getArtifactText(artifactId) : skipToken,
    staleTime: Infinity, // artifacts are immutable once created (§4)
  });
}

export interface ArtifactContentGateProps {
  artifact: Artifact;
  /** Names the artifact in the error copy: 'log' | 'decode' | 'diff'. */
  noun: string;
  content: UseQueryResult<string>;
  /** The tab's parse of content.data; null while there is no data yet. */
  parsed: { ok: true } | { ok: false; error: string } | null;
  /** What to render once the content is fetched and parsed. */
  children: ReactNode;
}

export function ArtifactContentGate({
  artifact,
  noun,
  content,
  parsed,
  children,
}: ArtifactContentGateProps) {
  if (content.isPending) {
    return (
      <p role="status" className="text-body text-text-secondary">
        Loading {artifact.label}…
      </p>
    );
  }
  if (content.isError) {
    return (
      <div role="alert" className="rounded-card border border-warn bg-warn-bg px-4 py-3">
        <p className="text-body font-medium text-warn">Couldn’t load the {noun} artifact</p>
        <p className="mt-1 text-meta text-text-secondary">
          {artifact.label} could not be fetched from the runner.
        </p>
        <Button variant="secondary" className="mt-3" onClick={() => void content.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!parsed || !parsed.ok) {
    return (
      <div role="alert" className="rounded-card border border-warn bg-warn-bg px-4 py-3">
        <p className="text-body font-medium text-warn">
          {noun.charAt(0).toUpperCase() + noun.slice(1)} artifact unreadable
        </p>
        <p className="mt-1 text-meta text-text-secondary">
          {artifact.label}: {parsed?.error ?? 'no content.'}
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
