// Evidence Detail tab model (BIBLE §7.4). All five tabs are live as of T3.2:
// Checks (default), Protocol Decode, Logs, Code Diff, Raw artifacts. Deep links
// (?artifact=<id>) resolve fail-closed: an id that isn't in RunView.artifacts
// lands on the Checks tab with an explicit notice — never a blank panel, never a
// crash. A known id always lands on its kind's own tab with the exact content.
import type { Artifact, ArtifactKind } from '@boardex/contract';

export type EvidenceTabId = 'checks' | 'sources' | 'decode' | 'logs' | 'diff' | 'raw';

export interface EvidenceTab {
  id: EvidenceTabId;
  label: string;
}

// §7.4 tab order. Labels follow the bible's naming.
export const EVIDENCE_TABS: readonly EvidenceTab[] = [
  { id: 'checks', label: 'Checks' },
  // Sources (T6.3) sits beside Checks — a check's citation deep-links straight here.
  { id: 'sources', label: 'Sources' },
  { id: 'decode', label: 'Protocol Decode' },
  { id: 'logs', label: 'Logs' },
  { id: 'diff', label: 'Code Diff' },
  { id: 'raw', label: 'Raw artifacts' },
];

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

// The most recently created artifact of a kind (artifacts[] is creation-ordered),
// or null when the run has produced none — a tab opened by hand shows the latest
// subject of its kind, mirroring the band's evidenceTargets rule.
export function latestOfKind(artifacts: readonly Artifact[], kind: ArtifactKind): Artifact | null {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const artifact = artifacts[i];
    if (artifact && artifact.kind === kind) return artifact;
  }
  return null;
}

export interface DeepLinkTarget {
  /** Tab to activate. */
  tab: EvidenceTabId;
  /**
   * The resolved artifact to open/highlight. Non-null exactly when `tab` is that
   * artifact's own tab — an unresolved link always lands on Checks with no artifact.
   */
  artifact: Artifact | null;
  /** Fail-closed explanation when the link couldn't land on its natural surface. */
  notice: string | null;
}

// Resolve ?artifact=<id> against RunView.artifacts. Every kind has a live tab, so a
// known id routes straight to its viewer; the only fail-closed branch is an id that
// isn't (yet) part of this run's evidence — a hand-typed id, or a link opened before
// the artifact.created event streamed in.
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

  return { tab: tabForArtifactKind(artifact.kind), artifact, notice: null };
}
