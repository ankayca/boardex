// Protocol Decode tab (BIBLE §7.4): fetch the protocol_decode artifact by
// reference (GET /artifacts/{id}, D4), parse with the Zod schema in decode.ts,
// render the monospace transaction table — time, address, r/w, ack, data bytes,
// annotation. Row tinting follows fixture-notes.md to the letter: fail bg tint
// ONLY on nack_at === "address"; the final-byte NACK of a successful master read
// is normal protocol and renders as an ordinary row. Fetch failures and content
// that isn't a valid decode both land in an explicit error state — fail-closed,
// no crash, no silently empty table.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact } from '@boardex/contract';
import { ArtifactContentGate, useArtifactContent } from './ArtifactContent';
import { decodeRows, parseProtocolDecode } from './decode';

// 32–36px rows (§7.4 compact decode density, Sprint 7 P1 #6): py-2 + the code
// line-height lands each row at ~34px. Tabular mono values align in columns.
const CELL = 'px-3 py-2 align-top font-mono';
// The value columns are frozen to their content (they never wrap); Annotation
// takes the remaining width and clamps.
const VALUE_CELL = `${CELL} whitespace-nowrap`;

// Annotation clamps to two lines; a click expands it in place (§7.4, P1 #6).
// Short annotations simply never overflow, so the toggle is a no-op for them.
function AnnotationCell({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (text === '—') {
    return <span className="text-text-secondary">—</span>;
  }
  return (
    <button
      type="button"
      aria-expanded={expanded}
      title={expanded ? 'Collapse annotation' : 'Expand annotation'}
      onClick={() => setExpanded((value) => !value)}
      // Collapsed uses line-clamp's own -webkit-box display; expanded falls back
      // to block. (A shared `block` would override line-clamp's display and defeat
      // the clamp — the two set `display` to different values.)
      className={`w-full text-left text-text-secondary ${expanded ? 'block' : 'line-clamp-2'}`}
    >
      {text}
    </button>
  );
}

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
                  <th className={`${VALUE_CELL} font-medium`}>Time</th>
                  <th className={`${VALUE_CELL} font-medium`}>Addr</th>
                  <th className={`${VALUE_CELL} font-medium`}>R/W</th>
                  <th className={`${VALUE_CELL} font-medium`}>Ack</th>
                  <th className={`${VALUE_CELL} font-medium`}>Data</th>
                  <th className={`${CELL} w-full font-medium`}>Annotation</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr
                    key={index}
                    ref={index === firstFailedIndex ? failedRowRef : undefined}
                    data-failed={row.failed || undefined}
                    data-group-start={row.groupStart || undefined}
                    // Subtle write/read-pair separators, no zebra: a group start
                    // pairs its border-b (light) with a stronger top rule for a
                    // slightly heavier boundary; intra-group rows keep only the
                    // light rule.
                    className={`border-b border-border ${
                      index > 0 && row.groupStart ? 'border-t border-border-strong' : ''
                    } ${row.failed ? 'bg-fail-bg' : ''}`}
                  >
                    <td className={`${VALUE_CELL} text-text-secondary`}>{row.time}</td>
                    <td className={`${VALUE_CELL} text-text-primary`}>{row.address}</td>
                    <td className={`${VALUE_CELL} text-text-primary`}>{row.rw}</td>
                    <td className={`${VALUE_CELL} text-text-primary`}>{row.ack}</td>
                    <td className={`${VALUE_CELL} text-text-primary`}>{row.data}</td>
                    <td className={`${CELL} text-text-secondary`}>
                      <AnnotationCell text={row.annotation} />
                    </td>
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
