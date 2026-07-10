// Protocol Decode tab (BIBLE §7.4): fetch the protocol_decode artifact by
// reference (GET /artifacts/{id}, D4), parse with the Zod schema in decode.ts,
// render the monospace transaction table — time, address, r/w, ack, data bytes,
// annotation. Row tinting follows fixture-notes.md to the letter: fail bg tint
// ONLY on nack_at === "address"; the final-byte NACK of a successful master read
// is normal protocol and renders as an ordinary row. Fetch failures and content
// that isn't a valid decode both land in an explicit error state — fail-closed,
// no crash, no silently empty table.
import { useEffect, useMemo, useRef } from 'react';
import type { Artifact } from '@boardex/contract';
import { ArtifactContentGate, useArtifactContent } from './ArtifactContent';
import { decodeRows, parseProtocolDecode } from './decode';

const CELL = 'px-3 py-1.5 align-top font-mono';

export interface DecodeTabProps {
  /** The decode artifact to render; null when the run has captured none yet. */
  artifact: Artifact | null;
  /** True when a deep link targeted this artifact — scroll to the first failed row. */
  scrollToFailure: boolean;
}

export function DecodeTab({ artifact, scrollToFailure }: DecodeTabProps) {
  const content = useArtifactContent(artifact?.id);

  const parsed = useMemo(
    () => (content.data !== undefined ? parseProtocolDecode(content.data) : null),
    [content.data],
  );
  const rows = useMemo(() => (parsed?.ok ? decodeRows(parsed.decode) : []), [parsed]);

  const failedRowRef = useRef<HTMLTableRowElement | null>(null);
  const firstFailedIndex = rows.findIndex((row) => row.failed);
  useEffect(() => {
    if (scrollToFailure) failedRowRef.current?.scrollIntoView?.({ block: 'center' });
  }, [scrollToFailure, firstFailedIndex]);

  if (!artifact) {
    return (
      <p role="status" className="text-body text-text-secondary">
        No protocol decode has been captured for this run yet.
      </p>
    );
  }

  return (
    <ArtifactContentGate artifact={artifact} noun="decode" content={content} parsed={parsed}>
      <div>
        <p className="text-meta text-text-secondary">{artifact.label}</p>
        {rows.length === 0 ? (
          <p role="status" className="mt-3 text-body text-text-secondary">
            The capture decoded, but contains no transactions.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table aria-label="Decoded transactions" className="w-full border-collapse text-meta">
              <thead>
                <tr className="border-b border-border text-left text-text-secondary">
                  <th className={`${CELL} font-medium`}>Time</th>
                  <th className={`${CELL} font-medium`}>Addr</th>
                  <th className={`${CELL} font-medium`}>R/W</th>
                  <th className={`${CELL} font-medium`}>Ack</th>
                  <th className={`${CELL} font-medium`}>Data</th>
                  <th className={`${CELL} font-medium`}>Annotation</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr
                    key={index}
                    ref={index === firstFailedIndex ? failedRowRef : undefined}
                    data-failed={row.failed || undefined}
                    className={`border-b border-border ${row.failed ? 'bg-fail-bg' : ''}`}
                  >
                    <td className={`${CELL} whitespace-nowrap text-text-secondary`}>{row.time}</td>
                    <td className={`${CELL} text-text-primary`}>{row.address}</td>
                    <td className={`${CELL} text-text-primary`}>{row.rw}</td>
                    <td className={`${CELL} whitespace-nowrap text-text-primary`}>{row.ack}</td>
                    <td className={`${CELL} text-text-primary`}>{row.data}</td>
                    <td className={`${CELL} text-text-secondary`}>{row.annotation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </ArtifactContentGate>
  );
}
