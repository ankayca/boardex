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
import { useState } from 'react';
import type { BenchDeviceKind, BenchDeviceState, BenchStatus, BoardProfile } from '@boardex/contract';
import { Button, Drawer, KeyValue, StatusDot } from '../../design';
import {
  matchInstruments,
  missingText,
  type InstrumentKind,
  type InstrumentMatch,
} from '../../lib/benchReadiness';
import { repoBasename } from '../../lib/repoBasename';

// Serial is not an instrument reference (§4: it is a port + baud, not a device the
// profile names), so it still reads through the bench device of its kind. With no
// snapshot or no device of that kind it reads offline — never an assumed online.
function deviceState(bench: BenchStatus | null, kind: BenchDeviceKind): BenchDeviceState {
  const device = bench?.devices.find((d) => d.kind === kind);
  return device?.state ?? 'offline';
}

/** A dot row (found or degraded) or a missing row, which has no device to have a state. */
type InstrumentRow =
  | { key: string; missing: false; state: BenchDeviceState; label: string }
  | { key: string; missing: true; reference: string };

// With no bench snapshot nothing can be resolved, so every referenced instrument reads
// offline against its own reference — the pre-T4.2 fallback, and still never an
// assumed online, nor a false "not found" against a bench we simply cannot see.
function instrumentRow(
  key: string,
  kind: InstrumentKind,
  reference: string,
  matches: InstrumentMatch[] | null,
): InstrumentRow {
  const match = matches?.find((candidate) => candidate.kind === kind);
  if (!match) return { key, missing: false, state: 'offline', label: reference };
  if (match.status === 'missing') return { key, missing: true, reference: match.reference };
  return {
    key,
    missing: false,
    state: match.deviceState ?? 'offline',
    label: match.deviceId ?? reference,
  };
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
  open,
  onClose,
}: {
  profile: BoardProfile;
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
      <aside aria-label="Board context">
        <div className="rounded-card border border-border bg-bg-panel p-5 shadow-subtle">
          <h2 className="text-section font-semibold text-text-primary">Board</h2>
          <p className="mt-2 text-meta text-text-secondary">
            {profileLoading ? 'Loading the board profile…' : `Profile unavailable (${boardProfileId}).`}
          </p>
        </div>
      </aside>
    );
  }

  const matches = bench ? matchInstruments(profile.instruments, bench) : null;
  const logicAnalyzer = profile.instruments.logicAnalyzer?.trim();
  const instruments: InstrumentRow[] = [
    instrumentRow('probe', 'debug_probe', profile.instruments.debugProbe, matches),
    {
      key: 'serial',
      missing: false,
      state: deviceState(bench, 'serial'),
      label: `${profile.serial.port} @ ${profile.serial.baud}`,
    },
    ...(logicAnalyzer ? [instrumentRow('la', 'logic_analyzer', logicAnalyzer, matches)] : []),
  ];

  return (
    <aside aria-label="Board context">
      <div className="rounded-card border border-border bg-bg-panel p-5 shadow-subtle">
        <h2 className="text-section font-semibold text-text-primary">{profile.name}</h2>
        <div className="mt-2">
          <KeyValue label="MCU" value={profile.mcu} mono />
          <KeyValue label="Repo" value={repoBasename(profile.repoPath)} mono />
        </div>
        <ul aria-label="Instruments" className="mt-3 space-y-1.5 border-t border-border pt-3">
          {instruments.map((instrument) => (
            <li key={instrument.key}>
              {instrument.missing ? (
                // No dot: there is no device whose state it could report. Amber per
                // D14, and the same sentence the other three surfaces render.
                <span className="text-meta text-warn">{missingText(instrument.reference)}</span>
              ) : (
                <StatusDot state={instrument.state} label={instrument.label} />
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-border pt-3 text-meta text-text-secondary">
          {safetyLine(profile)}
        </p>
        <Button variant="ghost" className="mt-3" onClick={() => setDetailsOpen(true)}>
          View details
        </Button>
      </div>
      <ProfileDetailsDrawer
        profile={profile}
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
      />
    </aside>
  );
}
