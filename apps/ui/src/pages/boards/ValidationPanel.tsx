// Validate Profile results (BIBLE §7.5 states: validated, device-missing warnings).
// Advisory by design: a bench changes between sessions, so a missing device warns and
// never blocks the save.
//
// Three states, three treatments (lib/benchReadiness):
//   found    — green dot + the device's id. Nothing to say; the dot says it.
//   degraded — the device's own StatusDot (amber offline, red error) plus
//              "<name> is on the bench but offline" — the fix is at the bench.
//   missing  — no dot (there is no device to have a state) and amber
//              "<reference> was not found on the bench" — the fix is in this form.
//
// Colors per D14. The panel frame is amber whenever anything warrants attention,
// because it is a warning about this profile. The StatusDot inside a matched row
// reports the DEVICE's own state, so a device the bench reports in error shows red
// deliberately.
import { StatusDot } from '../../design';
import { benchMatchText, hasBenchWarnings, type InstrumentMatch } from '../../lib/benchReadiness';

// One tight line per instrument (P1 #10): label · dot/message. Compact metadata
// rows rather than the roomier body layout — the panel is a findings list.
function MatchRow({ match }: { match: InstrumentMatch }) {
  const message = benchMatchText(match);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2.5 text-metadata">
      <span className="w-28 shrink-0 text-text-secondary">{match.label}</span>
      {match.status === 'missing' ? (
        <span className="text-warn">{message}</span>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot state={match.deviceState ?? 'online'} label={match.deviceId ?? ''} />
          {message && <span className="text-warn">{message}</span>}
        </span>
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
      className={`rounded-card border px-4 py-3 ${
        warnings ? 'border-warn bg-warn-bg' : 'border-pass bg-pass-bg'
      }`}
    >
      <p className={`text-meta font-medium ${warnings ? 'text-warn' : 'text-pass'}`}>
        {warnings
          ? 'Validated with warnings — some instruments are not on the bench'
          : 'Validated — every referenced instrument is on the bench'}
      </p>
      <ul className="mt-2 space-y-1">
        {matches.map((match) => (
          <MatchRow key={match.kind} match={match} />
        ))}
      </ul>
      {warnings && (
        <p className="mt-2 text-metadata text-text-secondary">
          You can still save this profile — benches change. Runs that need a missing
          instrument will fail at that step.
        </p>
      )}
    </section>
  );
}
