// Logs tab (BIBLE §7.4): serial / build / flash logs via the LogViewer
// primitive, one sub-tab per log-kind artifact in RunView.artifacts, labeled by
// kind + iteration (logs.ts) so iteration 1 vs 2 of one kind are both reachable.
// Content is fetched by reference (text/plain, D4); fetch failures and
// non-text content land in explicit error states per the T3.1 pattern.
import { useMemo, useState } from 'react';
import { skipToken, useQuery } from '@tanstack/react-query';
import type { Artifact, RunView } from '@boardex/contract';
import { Button, LogViewer } from '../../design';
import { api } from '../../lib/api';
import { logSubTabs, parseLogText } from './logs';

export interface LogsTabProps {
  view: RunView;
  /** The log artifact a deep link targeted, or null when opened by hand. */
  targetArtifact: Artifact | null;
}

export function LogsTab({ view, targetArtifact }: LogsTabProps) {
  const subTabs = useMemo(() => logSubTabs(view), [view]);

  // The deep link picks the sub-tab; the user can switch freely afterwards.
  // Derived-state reset (same pattern as the drawer's tab state): a new
  // ?artifact target re-derives the selection before painting.
  const targetId = targetArtifact?.id ?? null;
  const [selection, setSelection] = useState<{ target: string | null; id: string | null }>({
    target: targetId,
    id: targetId,
  });
  if (selection.target !== targetId) {
    setSelection({ target: targetId, id: targetId });
  }

  const selected =
    subTabs.find((tab) => tab.artifact.id === selection.id) ?? subTabs[0] ?? null;
  const artifactId = selected?.artifact.id;

  const content = useQuery({
    queryKey: ['artifact-content', artifactId],
    queryFn: artifactId ? () => api.getArtifactText(artifactId) : skipToken,
    staleTime: Infinity, // artifacts are immutable once created (§4)
  });

  const parsed = useMemo(
    () => (content.data !== undefined ? parseLogText(content.data) : null),
    [content.data],
  );

  if (subTabs.length === 0) {
    return (
      <p role="status" className="text-body text-text-secondary">
        No logs have been captured for this run yet.
      </p>
    );
  }

  return (
    <div>
      <div role="tablist" aria-label="Log artifacts" className="flex flex-wrap gap-1">
        {subTabs.map((tab) => {
          const isSelected = tab.artifact.id === selected?.artifact.id;
          return (
            <button
              key={tab.artifact.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => setSelection({ target: targetId, id: tab.artifact.id })}
              className={`rounded-button px-3 py-1.5 text-meta font-medium transition-colors ${
                isSelected
                  ? 'bg-neutral-badge-bg text-text-primary'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="mt-3">
        {selected && <p className="mb-2 text-meta text-text-secondary">{selected.artifact.label}</p>}
        {content.isPending ? (
          <p role="status" className="text-body text-text-secondary">
            Loading {selected?.artifact.label}…
          </p>
        ) : content.isError ? (
          <div role="alert" className="rounded-card border border-warn bg-warn-bg px-4 py-3">
            <p className="text-body font-medium text-warn">Couldn’t load the log artifact</p>
            <p className="mt-1 text-meta text-text-secondary">
              {selected?.artifact.label} could not be fetched from the runner.
            </p>
            <Button variant="secondary" className="mt-3" onClick={() => void content.refetch()}>
              Retry
            </Button>
          </div>
        ) : !parsed || !parsed.ok ? (
          <div role="alert" className="rounded-card border border-warn bg-warn-bg px-4 py-3">
            <p className="text-body font-medium text-warn">Log artifact unreadable</p>
            <p className="mt-1 text-meta text-text-secondary">
              {selected?.artifact.label}: {parsed?.error ?? 'no content.'}
            </p>
          </div>
        ) : (
          <LogViewer lines={parsed.lines} label={selected?.artifact.label ?? 'Log output'} />
        )}
      </div>
    </div>
  );
}
