// Evidence Detail tab model (BIBLE §7.4). T3.1 ships Checks + Protocol Decode;
// Logs / Code Diff / Raw artifacts exist as disabled tabs until T3.2. Deep links
// (?artifact=<id>) resolve fail-closed: an id that isn't in RunView.artifacts, or
// whose tab isn't built yet, lands on the Checks tab with an explicit notice —
// never a blank panel, never a crash.
import type { Artifact, ArtifactKind } from '@boardex/contract';

export type EvidenceTabId = 'checks' | 'decode' | 'logs' | 'diff' | 'raw';

export interface EvidenceTab {
  id: EvidenceTabId;
  label: string;
}

// §7.4 tab order. Labels follow the bible's naming.
export const EVIDENCE_TABS: readonly EvidenceTab[] = [
  { id: 'checks', label: 'Checks' },
  { id: 'decode', label: 'Protocol Decode' },
  { id: 'logs', label: 'Logs' },
  { id: 'diff', label: 'Code Diff' },
  { id: 'raw', label: 'Raw artifacts' },
];

// Tabs with content in T3.1; the rest render disabled with the T3.2 tooltip.
export const AVAILABLE_TABS: ReadonlySet<EvidenceTabId> = new Set(['checks', 'decode']);

export const T32_TOOLTIP = 'Arrives with T3.2';

// Which tab renders an artifact of this kind (§7.4's per-kind tab assignment).
export function tabForArtifactKind(kind: ArtifactKind): EvidenceTabId {
  switch (kind) {
    case 'protocol_decode':
      return 'decode';
    case 'serial_log':
    case 'build_log':
    case 'flash_log':
      return 'logs';
    case 'code_diff':
      return 'diff';
    case 'logic_capture':
    case 'timing_measurement':
    case 'report_md':
      return 'raw';
  }
}

export interface DeepLinkTarget {
  /** Tab to activate — always one that has content in T3.1. */
  tab: EvidenceTabId;
  /** The resolved artifact to highlight/scroll to, or null when none applies. */
  artifact: Artifact | null;
  /** Fail-closed explanation when the link couldn't land on its natural surface. */
  notice: string | null;
}

// Resolve ?artifact=<id> against RunView.artifacts. Fail-closed on every branch:
// unknown ids get an explicit notice, kinds whose tab is still T3.2 land on Checks
// with their linked check rows highlighted instead.
export function resolveDeepLink(
  artifacts: readonly Artifact[],
  artifactParam: string | null,
): DeepLinkTarget {
  if (!artifactParam) return { tab: 'checks', artifact: null, notice: null };

  const artifact = artifacts.find((candidate) => candidate.id === artifactParam) ?? null;
  if (!artifact) {
    return {
      tab: 'checks',
      artifact: null,
      notice: `Artifact "${artifactParam}" isn't part of this run's evidence.`,
    };
  }

  const tab = tabForArtifactKind(artifact.kind);
  if (AVAILABLE_TABS.has(tab)) return { tab, artifact, notice: null };

  return {
    tab: 'checks',
    artifact,
    notice: `The viewer for “${artifact.label}” arrives with T3.2. Checks backed by this artifact are highlighted below.`,
  };
}
