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
import { downloadArtifact, downloadFilename, humanizeSize } from './raw';

const CELL = 'px-3 py-2 align-middle';

export interface RawTabProps {
  view: RunView;
  /** Artifact id from the deep link; its row highlights and scrolls into view. */
  highlightArtifactId: string | null;
}

export function RawTab({ view, highlightArtifactId }: RawTabProps) {
  const highlightRef = useRef<HTMLTableRowElement | null>(null);
  const [failedDownloadId, setFailedDownloadId] = useState<string | null>(null);

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

  const download = async (artifact: Artifact) => {
    setFailedDownloadId(null);
    try {
      await downloadArtifact(artifact, api.getArtifactBlob);
    } catch {
      setFailedDownloadId(artifact.id);
    }
  };

  return (
    <div className="overflow-x-auto">
      <table aria-label="Raw artifacts" className="w-full border-collapse text-meta">
        <thead>
          <tr className="border-b border-border text-left text-text-secondary">
            <th className={`${CELL} font-medium`}>Kind</th>
            <th className={`${CELL} font-medium`}>Label</th>
            <th className={`${CELL} font-medium`}>Size</th>
            <th className={`${CELL} font-medium`}>
              <span className="sr-only">Download</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {view.artifacts.map((artifact) => {
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
                <td className={`${CELL} whitespace-nowrap font-mono text-text-primary`}>
                  {humanizeSize(artifact.sizeBytes)}
                </td>
                <td className={`${CELL} text-right`}>
                  <Button
                    variant="secondary"
                    title={`Download ${downloadFilename(artifact)}`}
                    onClick={() => void download(artifact)}
                  >
                    Download
                  </Button>
                  {failedDownloadId === artifact.id && (
                    <p role="alert" className="mt-1 text-meta text-warn">
                      Download failed — the artifact could not be fetched.
                    </p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
