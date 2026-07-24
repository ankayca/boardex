// Raw artifacts tab helpers (BIBLE §7.4): every RunView.artifact listed with
// kind, label, humanized size, and a Download that saves the content under a
// meaningful filename with the artifact's own MIME type. Downloads go through a
// same-origin Blob (content fetched by reference, D4) so the filename and MIME
// hold regardless of the runner's origin; logic captures save as sigrok .sr
// files that open in PulseView.
import type { Artifact, ArtifactKind, RunView } from '@boardex/contract';
import { iterationOfArtifact } from './logs';

// Filename extension by kind — the same mapping the mock runner stores fixture
// artifacts under; derived from the contract's kind enum, not invented per file.
const EXTENSION_BY_KIND: Record<ArtifactKind, string> = {
  serial_log: '.log',
  build_log: '.log',
  flash_log: '.log',
  logic_capture: '.sr',
  protocol_decode: '.json',
  code_diff: '.json',
  timing_measurement: '.json',
  report_md: '.md',
};

// Artifact ids are stable, human-readable slugs (e.g. "art_serial_log_iter1") —
// id + kind extension is the right filename for every fixture artifact.
export function downloadFilename(artifact: Pick<Artifact, 'id' | 'kind'>): string {
  return `${artifact.id}${EXTENSION_BY_KIND[artifact.kind]}`;
}

// Type order within an iteration group (§7.4 Raw grouping, Sprint 7 P1 #8):
// the run pipeline order — build → flash → serial, then the structured captures,
// the diff, and the report last. Derived from the contract kind enum, not per-file.
const KIND_ORDER: readonly ArtifactKind[] = [
  'build_log',
  'flash_log',
  'serial_log',
  'logic_capture',
  'protocol_decode',
  'timing_measurement',
  'code_diff',
  'report_md',
];

export interface ArtifactGroup {
  /** The fix-loop iteration, or null for artifacts whose step isn't in the view. */
  iteration: number | null;
  artifacts: Artifact[];
}

// Group the run's artifacts by iteration (via the same step→iteration derivation
// the Logs tab uses, D5), then order each group by type. Iterations ascend;
// iteration-unresolvable artifacts fall into a trailing null group — every
// artifact stays listed, nothing is dropped (the T3.2 principle).
export function groupArtifacts(view: RunView): ArtifactGroup[] {
  const byIteration = new Map<number | null, Artifact[]>();
  for (const artifact of view.artifacts) {
    const iteration = iterationOfArtifact(artifact, view);
    const bucket = byIteration.get(iteration);
    if (bucket) bucket.push(artifact);
    else byIteration.set(iteration, [artifact]);
  }
  const iterations = [...byIteration.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  });
  return iterations.map((iteration) => ({
    iteration,
    artifacts: byIteration
      .get(iteration)!
      .slice()
      .sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind)),
  }));
}

// "76 B" / "1.5 KB" / "10.7 KB" — binary steps, one decimal above bytes.
export function humanizeSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

// Exported for tests; downloadArtifact wires it in as the default `save`.
export function saveBlobViaAnchor(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  // Safari ignores clicks on anchors that aren't in the document, and revoking
  // the object URL synchronously can cancel the download it just started (the
  // fetch of a blob: URL is asynchronous) — attach first, defer the revoke.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Fetch-then-save. The blob carries artifact.mimeType (the §4 meta is the MIME
// authority) and the anchor carries the derived filename. `save` is injectable
// for tests; jsdom can't actually download.
export async function downloadArtifact(
  artifact: Artifact,
  getBlob: (artifactId: string, mimeType: string) => Promise<Blob>,
  save: (blob: Blob, filename: string) => void = saveBlobViaAnchor,
): Promise<void> {
  const blob = await getBlob(artifact.id, artifact.mimeType);
  save(blob, downloadFilename(artifact));
}
