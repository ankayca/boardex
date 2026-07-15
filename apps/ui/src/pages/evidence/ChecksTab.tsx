// Checks tab (BIBLE §7.4, default): one row per MeasurementCheck in RunView —
// requirement, expected window, actual value with unit, verdict badge, source ref,
// and a "view evidence" link deep-linking the check's artifact. The link is law-
// gated exactly like the band's chips: an artifactId with no artifact.created in
// RunView renders inert (aria-disabled, no href), never a dead link. (The T3.1
// highlight-on-Checks fallback is gone: every artifact kind now has its own tab,
// so deep links never land here carrying an artifact.)
import { Link } from 'react-router-dom';
import type { BoardDocument, MeasurementCheck, RunView } from '@boardex/contract';
import { Badge } from '../../design';
import { evidenceDocHrefAt, evidenceHrefAt } from '../workspace/evidence';
import { useEvidenceBase } from '../workspace/evidenceBase';
import { formatActual, formatExpected } from './checksTable';

const CELL = 'px-3 py-2 align-top';
const EVIDENCE_LINK_BASE = 'whitespace-nowrap text-meta font-medium';
const SOURCE_LINK = 'text-accent hover:text-accent-hover underline underline-offset-2';

export interface ChecksTabProps {
  view: RunView;
  /** Profile documents (T6.3): a check whose sourceDoc resolves to one deep-links. */
  documents?: readonly BoardDocument[];
}

// The Source cell (§7.4 / T6.3). A check's sourceDoc deep-links to the Sources tab
// at the exact document + locator WHEN that document is among the profile's
// documents; otherwise the free-text sourceRef renders plainly. Never a dead link:
// an unresolvable sourceDoc falls back to sourceRef, and a check with neither shows
// an em dash. The link text is the sourceRef when present (it names the section a
// human recognises), else the document's label.
function SourceCell({
  check,
  base,
  documentsById,
}: {
  check: MeasurementCheck;
  base: string;
  documentsById: Map<string, BoardDocument>;
}) {
  const doc = check.sourceDoc ? documentsById.get(check.sourceDoc.documentId) : undefined;
  if (check.sourceDoc && doc) {
    return (
      <Link
        to={evidenceDocHrefAt(base, check.sourceDoc.documentId, check.sourceDoc.locator)}
        className={SOURCE_LINK}
      >
        {check.sourceRef ?? doc.label}
      </Link>
    );
  }
  return <>{check.sourceRef ?? '—'}</>;
}

export function ChecksTab({ view, documents }: ChecksTabProps) {
  const base = useEvidenceBase(view.run.id);
  const artifactIds = new Set(view.artifacts.map((artifact) => artifact.id));
  const documentsById = new Map((documents ?? []).map((doc) => [doc.id, doc]));

  if (view.checks.length === 0) {
    return (
      <p role="status" className="text-body text-text-secondary">
        No checks have been evaluated yet.
      </p>
    );
  }

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
          {view.checks.map((check) => (
            <tr key={check.id} className="border-b border-border">
              <td className={CELL}>
                <span className="font-mono text-text-primary">{check.requirementId}</span>
                <p className="mt-0.5 text-text-secondary">{check.description}</p>
              </td>
              <td className={`${CELL} font-mono text-text-primary`}>
                {formatExpected(check.expected, check.actual.unit)}
              </td>
              <td className={`${CELL} font-mono text-text-primary`}>{formatActual(check.actual)}</td>
              <td className={CELL}>
                <Badge kind="verdict" value={check.verdict} />
              </td>
              <td className={`${CELL} text-text-secondary`}>
                <SourceCell check={check} base={base} documentsById={documentsById} />
              </td>
              <td className={CELL}>
                {artifactIds.has(check.artifactId) ? (
                  <Link
                    to={evidenceHrefAt(base, check.artifactId)}
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
          ))}
        </tbody>
      </table>
    </div>
  );
}
