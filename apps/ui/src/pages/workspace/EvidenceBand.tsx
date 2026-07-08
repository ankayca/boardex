// Bottom — Evidence Summary band (BIBLE §6.3/§7.3): the 88px collapsed strip. One
// chip per MeasurementCheck (verdict badge + short name, e.g. "I2C clock · PASS"),
// live from check.evaluated and in the reducer's evaluation order; plus Open Logs /
// Open Diff / Open Report, each deep-linking a real artifact on the Sprint-3 evidence
// route. A chip deep-links that check's own artifact. Before any check is evaluated,
// a quiet neutral line — not an empty box.
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

export function EvidenceBand({ view }: { view: RunView }) {
  const { run, checks } = view;
  const targets = evidenceTargets(view);

  return (
    <section
      aria-label="Evidence summary"
      className="mt-6 flex min-h-[88px] flex-wrap items-center gap-x-6 gap-y-3 rounded-card border border-border bg-bg-panel px-5 py-4 shadow-subtle"
    >
      {checks.length > 0 ? (
        <ul aria-label="Evidence checks" className="flex flex-1 flex-wrap items-center gap-2">
          {checks.map((check) => (
            <li key={check.id}>
              <Link
                to={evidenceHref(run.id, check.artifactId)}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-app px-3 py-1 transition-colors hover:border-accent"
              >
                <span className="text-meta font-medium text-text-primary">
                  {checkLabel(check.requirementId)}
                </span>
                <Badge kind="verdict" value={check.verdict} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex-1 text-meta text-text-secondary">No checks evaluated yet.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <BandAction label="Open Logs" to={targets.logs && evidenceHref(run.id, targets.logs)} />
        <BandAction label="Open Diff" to={targets.diff && evidenceHref(run.id, targets.diff)} />
        <BandAction label="Open Report" to={targets.report && evidenceHref(run.id, targets.report)} />
      </div>
    </section>
  );
}
