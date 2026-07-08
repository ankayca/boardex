// Right rail — Diagnosis Card (BIBLE §7.3): failed checks summarized, ranked
// hypotheses with confidence labels, proposed fix + risk, Approve Fix Plan. Evidence
// links are Sprint-3 stubs routing to /runs/:id/evidence?artifact=... (T3.3 wires the
// surface); no evidence rendering here. Approve Fix Plan approves the pending fix
// approval — fail-closed, the button exists in the DOM only once that approval is
// actually pending in view.
import { Link } from 'react-router-dom';
import type {
  Approval,
  Diagnosis,
  HypothesisConfidence,
  MeasurementCheck,
} from '@boardex/contract';
import { Badge, Button } from '../../design';
import { rankHypotheses } from './hypotheses';

const CONFIDENCE_LABELS: Record<HypothesisConfidence, string> = {
  high: 'High confidence',
  moderate: 'Moderate confidence',
  low: 'Low confidence',
};

export interface DiagnosisCardProps {
  diagnosis: Diagnosis;
  checks: readonly MeasurementCheck[];
  runId: string;
  /**
   * The pending fix approval once the run reaches its approval gate; null while
   * still diagnosing. Fail-closed: without it, no Approve control renders.
   */
  fixApproval: Approval | null;
  /** Resolve command in flight, or accepted and awaiting the approval.resolved event. */
  resolving: boolean;
  resolveError: string | null;
  onApproveFix: (approval: Approval) => void;
}

export function DiagnosisCard({
  diagnosis,
  checks,
  runId,
  fixApproval,
  resolving,
  resolveError,
  onApproveFix,
}: DiagnosisCardProps) {
  const checksById = new Map(checks.map((check) => [check.id, check]));
  // Every cited id renders: resolvable ones as check rows, the rest as an explicit
  // neutral "unavailable" line (T2.2 review F5) — never silently dropped. The
  // reducer records the matching contract-violation warning.
  const failedCheckRefs = diagnosis.failedCheckIds.map((id) => ({
    id,
    check: checksById.get(id),
  }));

  return (
    <section
      aria-label="Diagnosis"
      className="rounded-card border border-border bg-bg-panel p-5 shadow-subtle"
    >
      <h2 className="text-section font-semibold text-text-primary">Diagnosis</h2>

      {failedCheckRefs.length > 0 && (
        <ul aria-label="Failed checks" className="mt-3 space-y-2">
          {failedCheckRefs.map(({ id, check }) =>
            check ? (
              <li key={id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Badge kind="verdict" value={check.verdict} />
                <span className="min-w-0 flex-1 text-meta text-text-primary">{check.description}</span>
                <Link
                  to={`/runs/${runId}/evidence?artifact=${check.artifactId}`}
                  className="text-meta font-medium text-accent hover:text-accent-hover"
                >
                  View evidence
                </Link>
              </li>
            ) : (
              <li key={id} className="text-meta text-text-secondary">
                Referenced check unavailable
              </li>
            ),
          )}
        </ul>
      )}

      <h3 className="mt-4 border-t border-border pt-4 text-body font-medium text-text-primary">
        Likely causes
      </h3>
      <ol aria-label="Hypotheses" className="mt-2 space-y-3">
        {rankHypotheses(diagnosis.hypotheses).map((hypothesis, rank) => (
          <li key={hypothesis.cause} className="flex gap-2.5">
            <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-neutral-badge-bg text-center text-meta font-medium leading-5 text-neutral-badge">
              {rank + 1}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-meta font-medium text-text-primary">{hypothesis.cause}</span>
                <span className="inline-flex items-center whitespace-nowrap rounded-full bg-neutral-badge-bg px-2 py-0.5 text-meta font-medium text-neutral-badge">
                  {CONFIDENCE_LABELS[hypothesis.confidence]}
                </span>
              </div>
              <p className="mt-0.5 text-meta text-text-secondary">{hypothesis.evidence}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-4 border-t border-border pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-body font-medium text-text-primary">Proposed fix</h3>
          <Badge kind="risk" value={diagnosis.proposedFix.riskLevel} />
        </div>
        <p className="mt-1.5 text-meta text-text-secondary">{diagnosis.proposedFix.summary}</p>
        {diagnosis.proposedFix.filesChanged.length > 0 && (
          <ul aria-label="Fix files changed" className="mt-2 space-y-1">
            {diagnosis.proposedFix.filesChanged.map((file) => (
              <li key={file} className="font-mono text-meta text-text-primary">
                {file}
              </li>
            ))}
          </ul>
        )}
      </div>

      {resolveError && (
        <p role="alert" className="mt-4 rounded-card border border-warn bg-warn-bg px-3 py-2 text-meta text-warn">
          {resolveError}
        </p>
      )}

      {fixApproval ? (
        <Button
          variant="primary"
          className="mt-4 w-full"
          disabled={resolving}
          onClick={() => onApproveFix(fixApproval)}
        >
          {resolving ? 'Resolving…' : 'Approve Fix Plan'}
        </Button>
      ) : (
        <p className="mt-4 text-meta text-text-secondary">
          Waiting for the runner to request approval for this fix…
        </p>
      )}
    </section>
  );
}
