// Evidence Detail (BIBLE §7.4) — a Drawer over the Run Workspace at
// /runs/:id/evidence. T3.1 tabs: Checks (default) + Protocol Decode; Logs / Code
// Diff / Raw artifacts render disabled with the T3.2 tooltip. ?artifact=<id> deep
// links open the tab for that artifact's kind and highlight/scroll to the exact
// content (resolveDeepLink is fail-closed for unknown ids and unbuilt tabs), which
// is what makes every verdict traceable to its artifact in ≤2 clicks.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Artifact, RunView } from '@boardex/contract';
import { Drawer } from '../../design';
import { ChecksTab } from './ChecksTab';
import { DecodeTab } from './DecodeTab';
import {
  AVAILABLE_TABS,
  EVIDENCE_TABS,
  T32_TOOLTIP,
  resolveDeepLink,
  type EvidenceTabId,
} from './tabs';

// The decode tab's default subject when opened by hand: the most recent decode
// (artifacts[] is creation-ordered), mirroring the band's evidenceTargets rule.
function latestDecode(artifacts: readonly Artifact[]): Artifact | null {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const artifact = artifacts[i];
    if (artifact && artifact.kind === 'protocol_decode') return artifact;
  }
  return null;
}

export interface EvidenceDrawerProps {
  view: RunView;
  onClose: () => void;
}

export function EvidenceDrawer({ view, onClose }: EvidenceDrawerProps) {
  const [searchParams] = useSearchParams();
  const artifactParam = searchParams.get('artifact');
  const target = resolveDeepLink(view.artifacts, artifactParam);

  // The deep link picks the tab; the user can still switch tabs freely afterwards.
  // Derived-state reset (same pattern as useRunStream): when the ?artifact param
  // changes — a check row or band chip was clicked — re-derive before painting.
  const [tabState, setTabState] = useState<{ param: string | null; tab: EvidenceTabId }>({
    param: artifactParam,
    tab: target.tab,
  });
  if (tabState.param !== artifactParam) {
    setTabState({ param: artifactParam, tab: target.tab });
  }
  const activeTab = tabState.tab;

  const decodeArtifact =
    target.tab === 'decode' && target.artifact ? target.artifact : latestDecode(view.artifacts);

  return (
    <Drawer open title="Evidence" onClose={onClose} widthPx={760}>
      {target.notice && (
        <p role="status" className="mb-4 rounded-card border border-warn bg-warn-bg px-4 py-2 text-meta text-warn">
          {target.notice}
        </p>
      )}

      <div role="tablist" aria-label="Evidence tabs" className="flex gap-1 border-b border-border">
        {EVIDENCE_TABS.map((tab) => {
          const available = AVAILABLE_TABS.has(tab.id);
          const selected = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`evidence-panel-${tab.id}`}
              aria-disabled={available ? undefined : true}
              // title (not `disabled`) so the tooltip still shows on hover.
              title={available ? undefined : T32_TOOLTIP}
              onClick={() => {
                if (available) setTabState({ param: artifactParam, tab: tab.id });
              }}
              className={`-mb-px rounded-t-button border-b-2 px-4 py-2 text-body font-medium transition-colors ${
                selected
                  ? 'border-accent text-accent'
                  : available
                    ? 'border-transparent text-text-secondary hover:text-text-primary'
                    : 'cursor-not-allowed border-transparent text-text-secondary opacity-50'
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
        {activeTab === 'decode' ? (
          <DecodeTab
            artifact={decodeArtifact}
            scrollToFailure={target.tab === 'decode' && target.artifact !== null}
          />
        ) : (
          <ChecksTab
            view={view}
            highlightArtifactId={target.tab === 'checks' ? (target.artifact?.id ?? null) : null}
          />
        )}
      </div>
    </Drawer>
  );
}
