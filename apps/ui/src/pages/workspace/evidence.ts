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

// The Evidence Detail surface (§7.4), keyed by a real artifact id from RunView.
// The single source of every evidence deep link — the band's chips and actions, the
// Checks table, the Diagnosis Card's failed checks, and the Approval Card's Review
// Diff all route through here, and the drawer resolves the id to its kind's tab.
export function evidenceHref(runId: string, artifactId: string): string {
  return evidenceHrefAt(`/runs/${runId}`, artifactId);
}

// Base-relative forms (T6.5): the same links against an arbitrary run-surface base
// path so a reused surface can deep-link within it. Live callers use `/runs/${runId}`
// (the helpers above); the demo shell passes `/demo` via EvidenceBaseContext, so its
// bands, cards, and checks table deep-link to /demo/evidence and /demo/report rather
// than navigating out of the demo into a live run route.
export function evidenceHrefAt(base: string, artifactId: string): string {
  return `${base}/evidence?artifact=${artifactId}`;
}

export function reportHrefAt(base: string): string {
  return `${base}/report`;
}

// The Sources tab (§7.4, T6.3), opened at a specific document and optional locator.
// A check's sourceDoc citation routes through here — resolvable in the Checks table
// and the Validation Report — so a citation always lands on the exact section, never
// a dead link (the plain sourceRef text stays the fallback when it can't resolve).
export function evidenceDocHref(runId: string, documentId: string, locator?: string): string {
  return evidenceDocHrefAt(`/runs/${runId}`, documentId, locator);
}

export function evidenceDocHrefAt(base: string, documentId: string, locator?: string): string {
  const params = new URLSearchParams({ doc: documentId });
  if (locator) params.set('loc', locator);
  return `${base}/evidence?${params.toString()}`;
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
