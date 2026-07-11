// Logs tab (BIBLE §7.4): serial / build / flash logs via the LogViewer
// primitive, one sub-tab per log-kind artifact in RunView.artifacts, labeled by
// kind + iteration (logs.ts) so iteration 1 vs 2 of one kind are both reachable.
// Content plumbing (fetch by reference, D4; loading / fetch-error / unreadable
// gates) is the shared ArtifactContent pattern.
import { useMemo, useState } from 'react';
import type { Artifact, RunView } from '@boardex/contract';
import { LogViewer } from '../../design';
import { ArtifactContentGate, useArtifactContent } from './ArtifactContent';
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

  const selected = subTabs.find((tab) => tab.artifact.id === selection.id) ?? subTabs[0] ?? null;

  const content = useArtifactContent(selected?.artifact.id);
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
        {selected && (
          <>
            <p className="mb-2 text-meta text-text-secondary">{selected.artifact.label}</p>
            <ArtifactContentGate
              artifact={selected.artifact}
              noun="log"
              content={content}
              parsed={parsed}
            >
              {parsed?.ok && <LogViewer lines={parsed.lines} label={selected.artifact.label} />}
            </ArtifactContentGate>
          </>
        )}
      </div>
    </div>
  );
}
