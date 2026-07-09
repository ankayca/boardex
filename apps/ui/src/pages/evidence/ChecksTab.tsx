// Checks tab (BIBLE §7.4, default): one row per MeasurementCheck in RunView —
// requirement, expected window, actual value with unit, verdict badge, source ref,
// and a "view evidence" link deep-linking the check's artifact. The link is law-
// gated exactly like the band's chips: an artifactId with no artifact.created in
// RunView renders inert (aria-disabled, no href), never a dead link. A deep link
// whose artifact has no T3.1 viewer highlights the rows it backs instead.
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { RunView } from '@boardex/contract';
import { Badge } from '../../design';
import { evidenceHref } from '../workspace/evidence';
import { formatActual, formatExpected } from './checksTable';

const CELL = 'px-3 py-2 align-top';
const EVIDENCE_LINK_BASE = 'whitespace-nowrap text-meta font-medium';

export interface ChecksTabProps {
  view: RunView;
  /** Artifact id from the deep link; rows backed by it highlight and scroll into view. */
  highlightArtifactId: string | null;
}

export function ChecksTab({ view, highlightArtifactId }: ChecksTabProps) {
  const artifactIds = new Set(view.artifacts.map((artifact) => artifact.id));
  const highlightRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    highlightRef.current?.scrollIntoView?.({ block: 'center' });
  }, [highlightArtifactId]);

  if (view.checks.length === 0) {
    return (
      <p role="status" className="text-body text-text-secondary">
        No checks have been evaluated yet.
      </p>
    );
  }

  let highlightAssigned = false;

  return (
    <div className="overflow-x-auto">
      <table aria-label="Measurement checks" className="w-full border-collapse text-meta">
        <thead>
          <tr className="border-b border-border text-left text-text-secondary">
            <th className={`${CELL} font-medium`}>Requirement</th>
            <th className={`${CELL} font-medium`}>Expected</th>
            <th className={`${CELL} font-medium`}>Actual</th>
            <th className={`${CELL} font-medium`}>Verdict</th>
            <th className={`${CELL} font-medium`}>Source</th>
            <th className={`${CELL} font-medium`}>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {view.checks.map((check) => {
            const highlighted =
              highlightArtifactId !== null && check.artifactId === highlightArtifactId;
            const isScrollTarget = highlighted && !highlightAssigned;
            if (isScrollTarget) highlightAssigned = true;
            return (
              <tr
                key={check.id}
                ref={isScrollTarget ? highlightRef : undefined}
                data-highlighted={highlighted || undefined}
                className={`border-b border-border ${
                  highlighted ? 'outline outline-2 -outline-offset-2 outline-accent' : ''
                }`}
              >
                <td className={CELL}>
                  <span className="font-mono text-text-primary">{check.requirementId}</span>
                  <p className="mt-0.5 text-text-secondary">{check.description}</p>
                </td>
                <td className={`${CELL} font-mono text-text-primary`}>
                  {formatExpected(check.expected, check.actual.unit)}
                </td>
                <td className={`${CELL} font-mono text-text-primary`}>
                  {formatActual(check.actual)}
                </td>
                <td className={CELL}>
                  <Badge kind="verdict" value={check.verdict} />
                </td>
                <td className={`${CELL} text-text-secondary`}>{check.sourceRef ?? '—'}</td>
                <td className={CELL}>
                  {artifactIds.has(check.artifactId) ? (
                    <Link
                      to={evidenceHref(view.run.id, check.artifactId)}
                      className={`${EVIDENCE_LINK_BASE} text-accent hover:text-accent-hover`}
                    >
                      View evidence
                    </Link>
                  ) : (
                    <span
                      aria-disabled="true"
                      className={`${EVIDENCE_LINK_BASE} cursor-not-allowed text-text-secondary opacity-50`}
                    >
                      View evidence
                    </span>
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
