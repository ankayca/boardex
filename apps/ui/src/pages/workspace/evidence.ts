// Evidence Summary band derivation (BIBLE §7.3). Pure helpers over the reduced
// RunView — the band NEVER re-derives run state, it reads view.checks and
// view.artifacts (D5). The chip verdicts, their evaluation order, and iteration-2
// re-evaluation (replace-in-place vs. append) are exactly what the reducer carries.
import type { Artifact, RunView } from '@boardex/contract';

// A chip's short name comes from the check's requirementId (§4) — the only short
// identifier the contract carries — humanized for display: separators become spaces,
// acronym-ish tokens (those with a digit, e.g. "i2c") uppercase, first letter capitalized.
// "i2c_clock" -> "I2C clock", "device_ack" -> "Device ack", "serial_output" -> "Serial output".
export function checkLabel(requirementId: string): string {
  const humanized = requirementId
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => (/\d/.test(word) ? word.toUpperCase() : word.toLowerCase()))
    .join(' ');
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

// The Sprint-3 evidence surface, keyed by a real artifact id from RunView. Kept
// byte-identical to the Diagnosis Card's existing stub links (§7.3, T2.2) so both
// deep-link the same route — Sprint 3 (T3.3) renders it.
export function evidenceHref(runId: string, artifactId: string): string {
  return `/runs/${runId}/evidence?artifact=${artifactId}`;
}

// "Open Logs" prefers the serial console log, then build, then flash — the most
// human-relevant log lands first when several exist.
const LOG_KIND_PRIORITY: readonly Artifact['kind'][] = ['serial_log', 'build_log', 'flash_log'];

// The most recently created artifact of a kind (artifacts[] is creation-ordered), or
// null if none exists yet — so a button with no target renders disabled, never a
// dead link.
function lastArtifactId(artifacts: readonly Artifact[], kind: Artifact['kind']): string | null {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const artifact = artifacts[i];
    if (artifact && artifact.kind === kind) return artifact.id;
  }
  return null;
}

export interface EvidenceTargets {
  logs: string | null;
  diff: string | null;
  report: string | null;
}

// Real artifact ids for the band's Open Logs / Open Diff / Open Report buttons,
// derived from RunView.artifacts; any target with no artifact yet is null.
export function evidenceTargets(view: RunView): EvidenceTargets {
  let logs: string | null = null;
  for (const kind of LOG_KIND_PRIORITY) {
    logs = lastArtifactId(view.artifacts, kind);
    if (logs) break;
  }
  return {
    logs,
    diff: lastArtifactId(view.artifacts, 'code_diff'),
    report: lastArtifactId(view.artifacts, 'report_md'),
  };
}
