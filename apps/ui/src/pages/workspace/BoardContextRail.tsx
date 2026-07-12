// Left rail — Board Context (BIBLE §7.3): compact card with board name, MCU, repo
// basename, the instrument list with StatusDots from the live bench snapshot, the
// safety line, and "View details" opening a drawer with the full profile including
// the D12 connection checklist.
//
// The instrument rows resolve by REFERENCE, through lib/benchReadiness — the same
// three states the composer and the Board Profile Builder report (T4.2, Kerem's
// ruling). The rail is the surface an operator watches during a run, so an analyzer
// that is merely unplugged must not read the same as a profile naming an analyzer
// the bench has never heard of.
//
// Rows carry the DEVICE's human name, not its registry id (T4.2 review F4): the rail
// is 280px of glanceable context, and "Kingst LA2016" is what an operator recognises
// on the bench. The stable id it resolved to lives one click away, in the details
// drawer, where it is the thing you copy into a bug report.
//
// With no bench snapshot there is a FOURTH presentation, and it is not a state of the
// device: unknown. No dots, plain names, one neutral line. Its predecessor assumed
// offline on the theory that pessimism is safe, which reported a healthy analyzer as
// unplugged whenever the socket blinked. Never an assumed anything (review F5).
import { useState } from 'react';
import type { BenchDeviceState, BenchStatus, BoardProfile } from '@boardex/contract';
import { Button, Drawer, KeyValue, StatusDot } from '../../design';
import {
  matchInstruments,
  missingText,
  type InstrumentKind,
  type InstrumentMatch,
} from '../../lib/benchReadiness';
import { repoBasename } from '../../lib/repoBasename';

type InstrumentRow =
  /** Resolved: found or degraded, showing the device's own StatusDot. */
  | { key: string; kind: 'device'; state: BenchDeviceState; label: string }
  /** Nothing on this bench answers to the profile's reference — no device, no dot. */
  | { key: string; kind: 'missing'; reference: string }
  /** No bench snapshot: we know what the profile claims and nothing more. */
  | { key: string; kind: 'unknown'; label: string };

function instrumentRow(
  key: string,
  kind: InstrumentKind,
  reference: string,
  matches: InstrumentMatch[],
): InstrumentRow {
  const match = matches.find((candidate) => candidate.kind === kind);
  if (!match || match.status === 'missing') {
    return { key, kind: 'missing', reference: match?.reference ?? reference };
  }
  return {
    key,
    kind: 'device',
    state: match.deviceState ?? 'offline',
    label: match.deviceName ?? reference,
  };
}

// Serial is not an instrument reference (§4: it is a port + baud, not a device the
// profile names), so it resolves through the bench device of its kind. Its label stays
// the port and baud — that is what the operator wired, and what a mismatch would be
// about.
function serialRow(bench: BenchStatus, profile: BoardProfile): InstrumentRow {
  const label = `${profile.serial.port} @ ${profile.serial.baud}`;
  const device = bench.devices.find((d) => d.kind === 'serial');
  return device
    ? { key: 'serial', kind: 'device', state: device.state, label }
    : { key: 'serial', kind: 'missing', reference: label };
}

function instrumentRows(profile: BoardProfile, bench: BenchStatus | null): InstrumentRow[] {
  const logicAnalyzer = profile.instruments.logicAnalyzer?.trim();
  const serialLabel = `${profile.serial.port} @ ${profile.serial.baud}`;

  if (!bench) {
    return [
      { key: 'probe', kind: 'unknown', label: profile.instruments.debugProbe },
      { key: 'serial', kind: 'unknown', label: serialLabel },
      ...(logicAnalyzer ? [{ key: 'la', kind: 'unknown' as const, label: logicAnalyzer }] : []),
    ];
  }

  const matches = matchInstruments(profile.instruments, bench);
  return [
    instrumentRow('probe', 'debug_probe', profile.instruments.debugProbe, matches),
    serialRow(bench, profile),
    ...(logicAnalyzer ? [instrumentRow('la', 'logic_analyzer', logicAnalyzer, matches)] : []),
  ];
}

/** The stable ids the profile's references resolved to — the drawer's copy-me row (F4). */
function resolvedIds(profile: BoardProfile, bench: BenchStatus | null): { label: string; value: string }[] {
  const matches = bench ? matchInstruments(profile.instruments, bench) : [];
  const idFor = (kind: InstrumentKind, reference: string) =>
    matches.find((match) => match.kind === kind)?.deviceId ?? reference;
  const logicAnalyzer = profile.instruments.logicAnalyzer?.trim();
  return [
    { label: 'Debug probe', value: idFor('debug_probe', profile.instruments.debugProbe) },
    ...(logicAnalyzer
      ? [{ label: 'Logic analyzer', value: idFor('logic_analyzer', logicAnalyzer) }]
      : []),
  ];
}

function safetyLine(profile: BoardProfile): string {
  const { flashRequiresApproval, maxIterations, powerNote } = profile.safety;
  return [
    flashRequiresApproval ? 'Flash requires approval' : 'Flash approval not required',
    `Max ${maxIterations} iterations`,
    powerNote,
  ].join(' · ');
}

function ProfileDetailsDrawer({
  profile,
  instrumentIds,
  open,
  onClose,
}: {
  profile: BoardProfile;
  /** Stable registry ids the rail's rows resolved to; the rail itself shows names (F4). */
  instrumentIds: { label: string; value: string }[];
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer open={open} title={profile.name} onClose={onClose}>
      <div className="space-y-6">
        <section aria-label="Identity">
          <KeyValue label="MCU" value={profile.mcu} mono />
          <KeyValue label="Repository" value={profile.repoPath} mono />
        </section>
        <section aria-label="Instrument ids" className="border-t border-border pt-4">
          {instrumentIds.map((instrument) => (
            <KeyValue key={instrument.label} label={instrument.label} value={instrument.value} mono />
          ))}
        </section>
        <section aria-label="Firmware commands" className="border-t border-border pt-4">
          <KeyValue label="Build" value={profile.buildCommand} mono />
          <KeyValue label="Flash" value={profile.flashCommand} mono />
          <KeyValue label="Reset" value={profile.resetCommand} mono />
        </section>
        <section aria-label="Serial" className="border-t border-border pt-4">
          <KeyValue label="Port" value={profile.serial.port} mono />
          <KeyValue label="Baud" value={profile.serial.baud} mono />
        </section>
        <section aria-label="Safety" className="border-t border-border pt-4">
          <KeyValue label="Max iterations" value={profile.safety.maxIterations} />
          <KeyValue
            label="Flash approval"
            value={profile.safety.flashRequiresApproval ? 'Required' : 'Not required'}
          />
          <p className="mt-1 text-meta text-text-secondary">{profile.safety.powerNote}</p>
        </section>
        {profile.connectionChecklist.length > 0 && (
          <section aria-label="Connection checklist" className="border-t border-border pt-4">
            <h3 className="text-body font-medium text-text-primary">Connection checklist</h3>
            <ul className="mt-2 space-y-2">
              {profile.connectionChecklist.map((item) => (
                <li key={item.label} className="text-body text-text-primary">
                  <span className="font-medium">{item.label}</span>
                  <span className="text-text-secondary"> — {item.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {profile.knownQuirks.length > 0 && (
          <section aria-label="Known quirks" className="border-t border-border pt-4">
            <h3 className="text-body font-medium text-text-primary">Known quirks</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-body text-text-secondary">
              {profile.knownQuirks.map((quirk) => (
                <li key={quirk}>{quirk}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Drawer>
  );
}

export interface BoardContextRailProps {
  profile: BoardProfile | null;
  /** True while the profiles query is still in flight (vs. resolved-but-missing). */
  profileLoading: boolean;
  bench: BenchStatus | null;
  /** Fallback identity when the profile is unresolved. */
  boardProfileId: string;
}

export function BoardContextRail({
  profile,
  profileLoading,
  bench,
  boardProfileId,
}: BoardContextRailProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (!profile) {
    return (
      <aside aria-label="Board context" className="rail-sticky">
        <div className="rounded-card border border-border bg-bg-panel p-5 shadow-subtle">
          <h2 className="text-section font-semibold text-text-primary">Board</h2>
          <p className="mt-2 text-meta text-text-secondary">
            {profileLoading ? 'Loading the board profile…' : `Profile unavailable (${boardProfileId}).`}
          </p>
        </div>
      </aside>
    );
  }

  const instruments = instrumentRows(profile, bench);

  return (
    <aside aria-label="Board context" className="rail-sticky">
      <div className="rounded-card border border-border bg-bg-panel p-5 shadow-subtle">
        <h2 className="text-section font-semibold text-text-primary">{profile.name}</h2>
        <div className="mt-2">
          <KeyValue label="MCU" value={profile.mcu} mono />
          <KeyValue label="Repo" value={repoBasename(profile.repoPath)} mono />
        </div>
        <ul aria-label="Instruments" className="mt-3 space-y-1.5 border-t border-border pt-3">
          {instruments.map((instrument) => (
            <li key={instrument.key}>
              {instrument.kind === 'device' && (
                <StatusDot state={instrument.state} label={instrument.label} />
              )}
              {/* No dot: there is no device whose state it could report. Amber per D14,
                  and the same sentence the other three surfaces render. */}
              {instrument.kind === 'missing' && (
                <span className="text-meta text-warn">{missingText(instrument.reference)}</span>
              )}
              {/* Unknown: the profile's own reference, stated as a claim, not a status. */}
              {instrument.kind === 'unknown' && (
                <span className="text-meta text-text-secondary">{instrument.label}</span>
              )}
            </li>
          ))}
        </ul>
        {!bench && (
          // Neutral, not amber: an unreadable bench is not a warning about the bench.
          // Same sentence the composer's readiness shows (§7.2).
          <p className="mt-2 text-meta text-text-secondary">Bench status unavailable.</p>
        )}
        <p className="mt-3 border-t border-border pt-3 text-meta text-text-secondary">
          {safetyLine(profile)}
        </p>
        <Button variant="ghost" className="mt-3" onClick={() => setDetailsOpen(true)}>
          View details
        </Button>
      </div>
      <ProfileDetailsDrawer
        profile={profile}
        instrumentIds={resolvedIds(profile, bench)}
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
      />
    </aside>
  );
}
