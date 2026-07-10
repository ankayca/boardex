// Validate Profile results (BIBLE §7.5 states: validated, device-missing warnings).
// Advisory by design: a bench changes between sessions, so a missing device warns and
// never blocks the save. Colors per D14 — green only where a device is genuinely there
// and online, amber for every warning; nothing here is a failure.
import { StatusDot } from '../../design';
import { hasBenchWarnings, type InstrumentMatch } from './benchMatch';

function MatchRow({ match }: { match: InstrumentMatch }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="w-32 shrink-0 text-meta text-text-secondary">{match.label}</span>
      {match.status === 'missing' ? (
        <span className="text-body text-warn">
          Not detected — no bench device matches “{match.reference}”.
        </span>
      ) : (
        <>
          <StatusDot state={match.deviceState ?? 'online'} label={match.deviceId ?? ''} />
          {match.status === 'degraded' && (
            <span className="text-meta text-warn">
              detected but {match.deviceState === 'error' ? 'in error' : 'offline'}
            </span>
          )}
        </>
      )}
    </li>
  );
}

export function ValidationPanel({ matches }: { matches: readonly InstrumentMatch[] }) {
  const warnings = hasBenchWarnings(matches);
  return (
    <section
      aria-label="Bench validation"
      role="status"
      className={`rounded-card border px-5 py-4 ${
        warnings ? 'border-warn bg-warn-bg' : 'border-pass bg-pass-bg'
      }`}
    >
      <p className={`text-body font-medium ${warnings ? 'text-warn' : 'text-pass'}`}>
        {warnings
          ? 'Validated with warnings — some instruments are not on the bench'
          : 'Validated — every referenced instrument is on the bench'}
      </p>
      <ul className="mt-3 space-y-2">
        {matches.map((match) => (
          <MatchRow key={match.kind} match={match} />
        ))}
      </ul>
      {warnings && (
        <p className="mt-3 text-meta text-text-secondary">
          You can still save this profile — benches change. Runs that need a missing
          instrument will fail at that step.
        </p>
      )}
    </section>
  );
}
