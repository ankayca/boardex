// Bottom — Evidence Summary band (BIBLE §6.3/§7.3): the 88px collapsed strip. One
// chip per MeasurementCheck (verdict badge + short name, e.g. "I2C clock · PASS"),
// live from check.evaluated and in the reducer's evaluation order; plus Open Logs /
// Open Diff / Open Report, each deep-linking a real artifact on the Evidence Detail
// route (§7.4). A chip deep-links that check's own artifact — but only when that artifact
// actually exists in RunView.artifacts: an evidence-law downgrade (unresolvable
// artifactId) renders the chip inert, never a dead link. The strip holds its 88px:
// chips overflow horizontally in their own scroll container instead of wrapping the
// band taller. Before any check is evaluated, a quiet neutral line — not an empty box.
import { Link } from 'react-router-dom';
import type { RunView } from '@boardex/contract';
import { Badge } from '../../design';
import { checkLabel, evidenceHref, evidenceTargets } from './evidence';

// Secondary-button styling (mirrors design/Button's secondary variant) applied to a
// Link, so the actions are real anchors carrying an href. Disabled — no artifact of
// that kind yet — degrades to an inert span, never a dead link.
const ACTION_BASE =
  'inline-flex items-center justify-center rounded-button border border-border bg-bg-panel px-4 py-2 text-body font-medium text-text-primary transition-colors';

function BandAction({ label, to }: { label: string; to: string | null }) {
  if (to) {
    return (
      <Link to={to} className={`${ACTION_BASE} hover:bg-bg-app`}>
        {label}
      </Link>
    );
  }
  return (
    <span aria-disabled="true" className={`${ACTION_BASE} cursor-not-allowed opacity-50`}>
      {label}
    </span>
  );
}

const CHIP_BASE =
  'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-border bg-bg-app px-3 py-1';

export function EvidenceBand({ view }: { view: RunView }) {
  const { run, checks } = view;
  const targets = evidenceTargets(view);
  // Evidence-linking law (§4): only an artifactId with a live artifact.created in
  // RunView gets a link; the reducer has already downgraded the miss to needs_review.
  const artifactIds = new Set(view.artifacts.map((artifact) => artifact.id));

  return (
    <section
      aria-label="Evidence summary"
      className="mt-6 flex h-[88px] items-center gap-6 rounded-card border border-border bg-bg-panel px-5 shadow-subtle"
    >
      {checks.length > 0 ? (
        <ul
          aria-label="Evidence checks"
          className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-1"
        >
          {checks.map((check) => {
            const body = (
              <>
                <span className="text-meta font-medium text-text-primary">
                  {checkLabel(check.requirementId)}
                </span>
                <Badge kind="verdict" value={check.verdict} />
              </>
            );
            return (
              <li key={check.id} className="shrink-0">
                {artifactIds.has(check.artifactId) ? (
                  <Link
                    to={evidenceHref(run.id, check.artifactId)}
                    className={`${CHIP_BASE} transition-colors hover:border-accent`}
                  >
                    {body}
                  </Link>
                ) : (
                  <span aria-disabled="true" className={`${CHIP_BASE} cursor-not-allowed opacity-50`}>
                    {body}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="min-w-0 flex-1 text-meta text-text-secondary">No checks evaluated yet.</p>
      )}

      <div className="flex shrink-0 items-center gap-2">
        <BandAction label="Open Logs" to={targets.logs && evidenceHref(run.id, targets.logs)} />
        <BandAction label="Open Diff" to={targets.diff && evidenceHref(run.id, targets.diff)} />
        <BandAction label="Open Report" to={targets.report && evidenceHref(run.id, targets.report)} />
      </div>
    </section>
  );
}
