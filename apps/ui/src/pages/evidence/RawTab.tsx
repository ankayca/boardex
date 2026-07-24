// Raw artifacts tab (BIBLE §7.4): every RunView.artifact — kind, label,
// humanized size, Download. Downloads fetch content by reference (D4) and save
// through a Blob carrying the artifact's mimeType under the kind-derived
// filename (raw.ts) — logic captures land as sigrok .sr for PulseView. A deep
// link to a raw-tab kind (logic_capture / timing_measurement / report_md)
// highlights and scrolls to that artifact's row.
import { useEffect, useRef, useState } from 'react';
import type { Artifact, RunView } from '@boardex/contract';
import { Button } from '../../design';
import { api } from '../../lib/api';
import { downloadArtifact, downloadFilename, groupArtifacts, humanizeSize } from './raw';

const CELL = 'px-3 py-2 align-middle';

function DownloadGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none">
      <path
        d="M8 2.5v7m0 0L5 6.5m3 3l3-3M3 12.5h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface RawTabProps {
  view: RunView;
  /** Artifact id from the deep link; its row highlights and scrolls into view. */
  highlightArtifactId: string | null;
}

export function RawTab({ view, highlightArtifactId }: RawTabProps) {
  const highlightRef = useRef<HTMLTableRowElement | null>(null);
  const [failedDownloadIds, setFailedDownloadIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    highlightRef.current?.scrollIntoView?.({ block: 'center' });
  }, [highlightArtifactId]);

  if (view.artifacts.length === 0) {
    return (
      <p role="status" className="text-body text-text-secondary">
        No artifacts have been produced for this run yet.
      </p>
    );
  }

  // A download clears only its OWN failure marker before (re)trying, then re-marks
  // that same id on failure. Scoping the clear to the artifact's own id is what
  // lets Download-all accumulate: a later artifact's success never wipes an earlier
  // one's failure, and a single-row retry still clears only its own mark (P1 #8).
  const download = async (artifact: Artifact) => {
    setFailedDownloadIds((prev) => {
      if (!prev.has(artifact.id)) return prev;
      const next = new Set(prev);
      next.delete(artifact.id);
      return next;
    });
    try {
      await downloadArtifact(artifact, api.getArtifactBlob);
    } catch {
      setFailedDownloadIds((prev) => new Set(prev).add(artifact.id));
    }
  };

  // Download all: fetch-and-save each in turn (P1 #8). Sequential so a browser
  // doesn't cancel overlapping saves; each failure accumulates on its own row and
  // persists — a subsequent artifact succeeding does not clear it.
  const downloadAll = async () => {
    for (const artifact of view.artifacts) {
      await download(artifact);
    }
  };

  const groups = groupArtifacts(view);
  // Group headers only earn their space when there is more than one iteration to
  // separate; a single-group run reads as one flat, type-ordered list.
  const showGroupHeaders = groups.length > 1;

  return (
    <div>
      {/* Section header (P1 #8): one Download-all beside the count. */}
      <div className="mb-3 flex items-center justify-between gap-4">
        <p className="text-meta text-text-secondary">
          {view.artifacts.length} artifact{view.artifacts.length === 1 ? '' : 's'}
        </p>
        <Button variant="secondary" onClick={() => void downloadAll()}>
          Download all
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table aria-label="Raw artifacts" className="w-full border-collapse text-meta">
          <thead>
            <tr className="border-b border-border text-left text-text-secondary">
              <th className={`${CELL} font-medium`}>Kind</th>
              <th className={`${CELL} font-medium`}>Label</th>
              <th className={`${CELL} text-right font-medium`}>Size</th>
              <th className={`${CELL} font-medium`}>
                <span className="sr-only">Download</span>
              </th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.iteration ?? 'unassigned'}>
              {showGroupHeaders && (
                <tr>
                  <td
                    colSpan={4}
                    className="border-b border-border bg-canvas px-3 py-1.5 text-metadata font-medium uppercase tracking-wide text-text-secondary"
                  >
                    {group.iteration === null ? 'Run-level' : `Iteration ${group.iteration}`}
                  </td>
                </tr>
              )}
              {group.artifacts.map((artifact) => {
                const highlighted = artifact.id === highlightArtifactId;
                return (
                  <tr
                    key={artifact.id}
                    ref={highlighted ? highlightRef : undefined}
                    data-highlighted={highlighted || undefined}
                    className={`border-b border-border ${
                      highlighted ? 'outline outline-2 -outline-offset-2 outline-accent' : ''
                    }`}
                  >
                    <td className={`${CELL} whitespace-nowrap font-mono text-text-secondary`}>
                      {artifact.kind}
                    </td>
                    <td className={`${CELL} text-text-primary`}>{artifact.label}</td>
                    <td className={`${CELL} whitespace-nowrap text-right font-mono text-text-primary`}>
                      {humanizeSize(artifact.sizeBytes)}
                    </td>
                    <td className={`${CELL} text-right`}>
                      {/* Compact row-end icon action (P1 #8): the accessible name
                          stays "Download"; the filename rides the tooltip. */}
                      <button
                        type="button"
                        aria-label="Download"
                        title={`Download ${downloadFilename(artifact)}`}
                        onClick={() => void download(artifact)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-control text-text-secondary transition-colors duration-fast ease-motion hover:bg-canvas hover:text-text-primary"
                      >
                        <DownloadGlyph />
                      </button>
                      {failedDownloadIds.has(artifact.id) && (
                        <p role="alert" className="mt-1 text-meta text-warn">
                          Download failed — the artifact could not be fetched.
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}
