// Bottom — Evidence Summary band (BIBLE §6.3/§7.3): the 88px collapsed strip. One
// chip per MeasurementCheck (verdict badge + short name, e.g. "I2C clock · PASS"),
// live from check.evaluated and in the reducer's evaluation order; plus Open Logs /
// Open Diff / Open Report, each deep-linking a real artifact on the Evidence Detail
// route (§7.4). A chip deep-links that check's own artifact — but only when that artifact
// actually exists in RunView.artifacts: an evidence-law downgrade (unresolvable
// artifactId) renders the chip inert, never a dead link. The strip holds its 88px:
// chips overflow horizontally in their own scroll container instead of wrapping the
// band taller. Before any check is evaluated, a quiet neutral line — not an empty box.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CheckVerdict, RunView } from '@boardex/contract';
import { Badge } from '../../design';
import { checkLabel, evidenceHrefAt, evidenceTargets, reportHrefAt } from './evidence';
import { useEvidenceBase } from './evidenceBase';

// The iteration-2 verdict-flip moment (T6.2 item 3): when a check the reducer
// upserts by id flips FAIL → PASS on re-evaluation, its badge plays a one-shot
// emphasis. Tracked in state (not a render-time diff) with a timer just past the
// gentle token, so an interleaved re-render can't truncate the animation. Green
// only because the verdict now IS pass (D14 — the emphasis is the flip landing,
// not decoration). First render seeds the baseline, so a reloaded pass never flips.
function useVerdictFlips(checks: readonly { id: string; verdict: CheckVerdict }[]): Set<string> {
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set());
  const prev = useRef<Map<string, CheckVerdict>>(new Map());

  useEffect(() => {
    const newlyPassed: string[] = [];
    for (const check of checks) {
      if (prev.current.get(check.id) === 'fail' && check.verdict === 'pass') {
        newlyPassed.push(check.id);
      }
      prev.current.set(check.id, check.verdict);
    }
    if (newlyPassed.length === 0) return;
    setFlipped((current) => new Set([...current, ...newlyPassed]));
    const timer = window.setTimeout(() => {
      setFlipped((current) => {
        const next = new Set(current);
        for (const id of newlyPassed) next.delete(id);
        return next;
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [checks]);

  return flipped as Set<string>;
}

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
  const base = useEvidenceBase(run.id);
  const targets = evidenceTargets(view);
  // Evidence-linking law (§4): only an artifactId with a live artifact.created in
  // RunView gets a link; the reducer has already downgraded the miss to needs_review.
  const artifactIds = new Set(view.artifacts.map((artifact) => artifact.id));
  const flipped = useVerdictFlips(checks);

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
                <span className={flipped.has(check.id) ? 'inline-flex animate-verdict-flip' : 'inline-flex'}>
                  <Badge kind="verdict" value={check.verdict} />
                </span>
              </>
            );
            return (
              // T6.2: each chip rises + fades in (fast) as its check.evaluated lands.
              <li key={check.id} className="animate-chip-in shrink-0">
                {artifactIds.has(check.artifactId) ? (
                  <Link
                    to={evidenceHrefAt(base, check.artifactId)}
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
        <BandAction label="Open Logs" to={targets.logs && evidenceHrefAt(base, targets.logs)} />
        <BandAction label="Open Diff" to={targets.diff && evidenceHrefAt(base, targets.diff)} />
        {/* Open Report opens the dedicated §7.6 Validation Report screen (not the
            evidence drawer); disabled until the run's report_md artifact exists. */}
        <BandAction label="Open Report" to={targets.report ? reportHrefAt(base) : null} />
      </div>
    </section>
  );
}
