// Logs tab derivation (BIBLE §7.4): one sub-tab per log-kind artifact in
// RunView.artifacts, in creation order. Sub-tab labels are derived from the
// artifact's step so several logs of one kind (iteration 1 vs 2 serial logs)
// stay distinguishable: kind display name + the iteration the emitting step
// belongs to (via RunView.iterations, D5 — never re-derived from raw events).
// Content is plain text fetched by reference; parseLogText fails closed on
// content that isn't renderable text, per the T3.1 decode pattern.
import type { Artifact, ArtifactKind, RunView } from '@boardex/contract';

export const LOG_KINDS: ReadonlySet<ArtifactKind> = new Set([
  'serial_log',
  'build_log',
  'flash_log',
]);

const KIND_NAME: Partial<Record<ArtifactKind, string>> = {
  serial_log: 'Serial',
  build_log: 'Build',
  flash_log: 'Flash',
};

// The fix-loop iteration the artifact's step belongs to: the highest iteration
// whose firstStepIndex is at or before the step (§5.4; iteration 1 is implicit).
// Null when the artifact's step isn't in RunView.steps — no guessing.
export function iterationOfArtifact(artifact: Artifact, view: RunView): number | null {
  const stepIndex = view.steps.findIndex((step) => step.id === artifact.stepId);
  if (stepIndex < 0) return null;
  let iteration = 1;
  for (const entry of view.iterations) {
    if (stepIndex >= entry.firstStepIndex && entry.iteration > iteration) {
      iteration = entry.iteration;
    }
  }
  return iteration;
}

export interface LogSubTab {
  artifact: Artifact;
  label: string;
}

// One sub-tab per log-kind artifact. Label: "Serial — iteration 2"; when the
// step (and so the iteration) can't be resolved, the artifact's own label is the
// honest fallback. Duplicate labels (two logs of one kind in one iteration) get
// an ordinal suffix so every sub-tab stays reachable and distinguishable.
export function logSubTabs(view: RunView): LogSubTab[] {
  const tabs = view.artifacts
    .filter((artifact) => LOG_KINDS.has(artifact.kind))
    .map((artifact) => {
      const iteration = iterationOfArtifact(artifact, view);
      const label =
        iteration !== null
          ? `${KIND_NAME[artifact.kind]} — iteration ${iteration}`
          : artifact.label;
      return { artifact, label };
    });

  const seen = new Map<string, number>();
  return tabs.map((tab) => {
    const count = (seen.get(tab.label) ?? 0) + 1;
    seen.set(tab.label, count);
    return count === 1 ? tab : { ...tab, label: `${tab.label} (${count})` };
  });
}

export type LogParseResult = { ok: true; lines: string[] } | { ok: false; error: string };

// Logs are text/plain (§4). Binary content (a mislabeled artifact) fails closed
// instead of rendering mojibake; CRLF is normalized and one trailing newline
// doesn't produce a phantom empty line.
export function parseLogText(text: string): LogParseResult {
  if (text.includes('\u0000')) {
    return { ok: false, error: 'Artifact content is not renderable text.' };
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return { ok: true, lines };
}
