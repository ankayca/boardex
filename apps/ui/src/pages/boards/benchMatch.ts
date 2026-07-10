// Validate a profile's instruments against the live bench (BIBLE §7.5: "Validate
// Profile button calls GET /bench and marks each referenced device found/missing").
// Pure derivation, so the panel that renders it has no logic of its own.
//
// Matching rule, deliberately exact rather than fuzzy: within the devices of the same
// kind, a reference matches a device's stable registry id (§4 BenchStatus.devices.id)
// first, then its name case-insensitively. The detected-device picker writes the id,
// so a picked instrument always matches; a hand-typed one matches only when it is
// literally the device's id or name. Anything looser would let a profile claim an
// instrument the runner cannot resolve.
import type { BenchDeviceState, BenchStatus, BoardProfile } from '@boardex/contract';

/** The two instrument kinds §7.5's Instruments section references. */
export type InstrumentKind = 'debug_probe' | 'logic_analyzer';

export type InstrumentMatchStatus =
  /** Matched a device the bench reports online. */
  | 'found'
  /** Matched a device that is offline or in error — the bench is degraded, not wrong. */
  | 'degraded'
  /** No device of that kind answers to this reference. */
  | 'missing';

export interface InstrumentMatch {
  kind: InstrumentKind;
  /** Human label for the field this reference came from. */
  label: string;
  /** What the profile stores — a device id (picker) or free text. */
  reference: string;
  status: InstrumentMatchStatus;
  /** The matched device's stable id; absent when missing. */
  deviceId?: string;
  deviceState?: BenchDeviceState;
}

const LABELS: Record<InstrumentKind, string> = {
  debug_probe: 'Debug probe',
  logic_analyzer: 'Logic analyzer',
};

function matchOne(bench: BenchStatus, kind: InstrumentKind, reference: string): InstrumentMatch {
  const ref = reference.trim();
  const candidates = bench.devices.filter((device) => device.kind === kind);
  const device =
    candidates.find((candidate) => candidate.id === ref) ??
    candidates.find((candidate) => candidate.name.trim().toLowerCase() === ref.toLowerCase());

  if (!device) return { kind, label: LABELS[kind], reference: ref, status: 'missing' };
  return {
    kind,
    label: LABELS[kind],
    reference: ref,
    status: device.state === 'online' ? 'found' : 'degraded',
    deviceId: device.id,
    deviceState: device.state,
  };
}

/**
 * One row per instrument the profile actually references. The logic analyzer is
 * optional (§4), so an unset one is not a missing device — it is simply not claimed.
 */
export function matchInstruments(
  instruments: BoardProfile['instruments'],
  bench: BenchStatus,
): InstrumentMatch[] {
  const matches: InstrumentMatch[] = [matchOne(bench, 'debug_probe', instruments.debugProbe)];
  const logicAnalyzer = instruments.logicAnalyzer?.trim();
  if (logicAnalyzer) matches.push(matchOne(bench, 'logic_analyzer', logicAnalyzer));
  return matches;
}

/** Whether any referenced instrument is missing or degraded — advisory, never blocking. */
export function hasBenchWarnings(matches: readonly InstrumentMatch[]): boolean {
  return matches.some((match) => match.status !== 'found');
}
