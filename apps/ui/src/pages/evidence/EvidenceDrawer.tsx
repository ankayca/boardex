// Evidence Detail (BIBLE §7.4) — a Drawer over the Run Workspace at
// /runs/:id/evidence. All five tabs are live (T3.1: Checks + Protocol Decode;
// T3.2: Logs + Code Diff + Raw artifacts). ?artifact=<id> deep links open the
// tab for that artifact's kind with the exact content (resolveDeepLink is
// fail-closed for unknown ids), which is what makes every verdict traceable to
// its artifact in ≤2 clicks.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Artifact, RunView } from '@boardex/contract';
import { Drawer } from '../../design';
import { ChecksTab } from './ChecksTab';
import { DecodeTab } from './DecodeTab';
import { DiffTab } from './DiffTab';
import { LogsTab } from './LogsTab';
import { RawTab } from './RawTab';
import { EVIDENCE_TABS, latestOfKind, resolveDeepLink, type EvidenceTabId } from './tabs';

export interface EvidenceDrawerProps {
  view: RunView;
  onClose: () => void;
}

export function EvidenceDrawer({ view, onClose }: EvidenceDrawerProps) {
  const [searchParams] = useSearchParams();
  const artifactParam = searchParams.get('artifact');
  const target = resolveDeepLink(view.artifacts, artifactParam);

  // The deep link picks the tab; the user can still switch tabs freely afterwards.
  // Derived-state reset (same pattern as useRunStream): re-derive before painting
  // when the ?artifact param changes — a check row or band chip was clicked — OR
  // when the param's resolution changes: a link can reference an artifact whose
  // artifact.created hasn't streamed in yet, in which case the drawer shows the
  // fail-closed notice on Checks and must route to the artifact's own tab the
  // moment it lands in RunView.artifacts.
  const resolvedId = target.artifact?.id ?? null;
  const [tabState, setTabState] = useState<{
    param: string | null;
    resolvedId: string | null;
    tab: EvidenceTabId;
  }>({ param: artifactParam, resolvedId, tab: target.tab });
  if (tabState.param !== artifactParam || tabState.resolvedId !== resolvedId) {
    setTabState({ param: artifactParam, resolvedId, tab: target.tab });
  }
  const activeTab = tabState.tab;

  // Each content tab's subject: the deep-linked artifact when it belongs to that
  // tab, else the most recent artifact of the tab's kind (opened by hand).
  const targetFor = (tab: EvidenceTabId): Artifact | null =>
    target.tab === tab ? target.artifact : null;
  const decodeArtifact = targetFor('decode') ?? latestOfKind(view.artifacts, 'protocol_decode');
  const diffArtifact = targetFor('diff') ?? latestOfKind(view.artifacts, 'code_diff');

  return (
    <Drawer open title="Evidence" onClose={onClose} widthPx={760}>
      {target.notice && (
        <p role="status" className="mb-4 rounded-card border border-warn bg-warn-bg px-4 py-2 text-meta text-warn">
          {target.notice}
        </p>
      )}

      <div role="tablist" aria-label="Evidence tabs" className="flex gap-1 border-b border-border">
        {EVIDENCE_TABS.map((tab) => {
          const selected = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`evidence-panel-${tab.id}`}
              onClick={() => setTabState({ param: artifactParam, resolvedId, tab: tab.id })}
              className={`-mb-px rounded-t-button border-b-2 px-4 py-2 text-body font-medium transition-colors ${
                selected
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        id={`evidence-panel-${activeTab}`}
        role="tabpanel"
        aria-label={EVIDENCE_TABS.find((tab) => tab.id === activeTab)?.label}
        className="pt-4"
      >
        {activeTab === 'checks' && <ChecksTab view={view} />}
        {activeTab === 'decode' && (
          <DecodeTab
            artifact={decodeArtifact}
            scrollToFailure={target.tab === 'decode' && target.artifact !== null}
          />
        )}
        {activeTab === 'logs' && <LogsTab view={view} targetArtifact={targetFor('logs')} />}
        {activeTab === 'diff' && <DiffTab view={view} artifact={diffArtifact} />}
        {activeTab === 'raw' && (
          <RawTab view={view} highlightArtifactId={targetFor('raw')?.id ?? null} />
        )}
      </div>
    </Drawer>
  );
}
