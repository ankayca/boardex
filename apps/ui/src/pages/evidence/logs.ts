// Logs tab derivation (BIBLE §7.4, Sprint 7 P0): the drawer's log navigation is
// two compact selectors — Iteration [1|2] × Type [Build|Flash|Serial] — instead
// of one flat sub-tab per artifact (six tabs wrapped onto two lines in the
// drawer). logMatrix derives the axes from RunView (iteration via
// RunView.iterations, D5 — never re-derived from raw events); log content is
// plain text fetched by reference; parseLogText fails closed on content that
// isn't renderable text, per the T3.1 decode pattern.
import type { Artifact, ArtifactKind, RunView } from '@boardex/contract';

export const LOG_KINDS: ReadonlySet<ArtifactKind> = new Set([
  'serial_log',
  'build_log',
  'flash_log',
]);

/** Fixed Type-selector order (build → flash → serial, the pipeline order). */
export const LOG_KIND_ORDER: readonly ArtifactKind[] = ['build_log', 'flash_log', 'serial_log'];

export const LOG_KIND_NAME: Partial<Record<ArtifactKind, string>> = {
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

export interface LogCombo {
  iteration: number;
  kind: ArtifactKind;
}

export interface LogMatrix {
  /** Iterations with at least one log artifact, ascending. */
  iterations: number[];
  /** Log kinds present anywhere in the run, in LOG_KIND_ORDER. */
  kinds: ArtifactKind[];
  /** The first log artifact in creation order — the no-deep-link default. */
  first: Artifact | null;
  /** Latest artifact for an (iteration, kind) cell; null when the cell is empty. */
  at(iteration: number, kind: ArtifactKind): Artifact | null;
  /** The cell a log artifact belongs to; null when its step is unresolvable. */
  comboOf(artifactId: string): LogCombo | null;
  /**
   * Log artifacts whose iteration can't be resolved (their step is not in the
   * view). Rendered as an explicit fallback list — every artifact stays
   * reachable, nothing is silently dropped (T3.2 principle).
   */
  unassigned: Artifact[];
}

// The Iteration × Type matrix behind the two selectors. A cell holds the LATEST
// artifact of that kind in that iteration (creation order); an older duplicate
// stays reachable through its deep link, whose combo still resolves here.
export function logMatrix(view: RunView): LogMatrix {
  const logs = view.artifacts.filter((artifact) => LOG_KINDS.has(artifact.kind));
  const cells = new Map<string, Artifact>();
  const combos = new Map<string, LogCombo>();
  const iterations = new Set<number>();
  const kindsPresent = new Set<ArtifactKind>();
  const unassigned: Artifact[] = [];

  for (const artifact of logs) {
    const iteration = iterationOfArtifact(artifact, view);
    if (iteration === null) {
      unassigned.push(artifact);
      continue;
    }
    iterations.add(iteration);
    kindsPresent.add(artifact.kind);
    cells.set(`${iteration}:${artifact.kind}`, artifact);
    combos.set(artifact.id, { iteration, kind: artifact.kind });
  }

  return {
    iterations: [...iterations].sort((a, b) => a - b),
    kinds: LOG_KIND_ORDER.filter((kind) => kindsPresent.has(kind)),
    first: logs[0] ?? null,
    at: (iteration, kind) => cells.get(`${iteration}:${kind}`) ?? null,
    comboOf: (artifactId) => combos.get(artifactId) ?? null,
    unassigned,
  };
}

export type LogParseResult = { ok: true; lines: string[] } | { ok: false; error: string };

// ANSI CSI sequences (ESC [ params final-byte) — colored/cursor output from
// real firmware serial consoles. Legitimate text, but noise in the LogViewer
// and no evidence of binary content, so they are stripped before the gate.
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

// Binary detection threshold: the proportion of control characters (excluding
// \n, \r, \t) above which content is treated as a mislabeled binary artifact.
// A stray control byte in a genuine log stays far below it; NUL-free binary
// (e.g. a raw capture served under a log id) sits far above it.
const MAX_CONTROL_PROPORTION = 0.05;

const NOT_TEXT = { ok: false, error: 'Artifact content is not renderable text.' } as const;

// Logs are text/plain (§4). Binary content (a mislabeled artifact) fails closed
// instead of rendering mojibake: any NUL, or a control-character proportion
// above MAX_CONTROL_PROPORTION after ANSI stripping, rejects the content. CRLF
// is normalized and one trailing newline doesn't produce a phantom empty line.
export function parseLogText(text: string): LogParseResult {
  if (text.includes('\u0000')) return NOT_TEXT;
  const stripped = text.replace(ANSI_CSI_RE, '');
  let controls = 0;
  for (const char of stripped) {
    const code = char.codePointAt(0) as number;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      controls++;
    }
  }
  if (stripped.length > 0 && controls / stripped.length > MAX_CONTROL_PROPORTION) return NOT_TEXT;
  const lines = stripped.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return { ok: true, lines };
}
