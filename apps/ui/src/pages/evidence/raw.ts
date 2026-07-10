// Raw artifacts tab helpers (BIBLE §7.4): every RunView.artifact listed with
// kind, label, humanized size, and a Download that saves the content under a
// meaningful filename with the artifact's own MIME type. Downloads go through a
// same-origin Blob (content fetched by reference, D4) so the filename and MIME
// hold regardless of the runner's origin; logic captures save as sigrok .sr
// files that open in PulseView.
import type { Artifact, ArtifactKind } from '@boardex/contract';

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
