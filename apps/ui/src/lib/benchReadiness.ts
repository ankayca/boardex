// Bench matching, one derivation for every surface that reports it (BIBLE §7.2 /
// §7.5). Lives in lib/ rather than under a page because three screens read it: the
// Board Profile Builder's ValidationPanel, the composer's inline readiness + its
// repeat at plan approval, and Home's advisory attention line.
//
// THREE STATES, never collapsed into two — the whole point is that an operator can
// tell "my analyzer is unplugged" from "my profile names something that doesn't
// exist", because the fixes are different (plug it in vs. edit the profile):
//   found    — a device of that kind answers to the reference and is online.
//   degraded — a device answers, but the bench reports it offline or in error.
//   missing  — nothing on the bench answers to that reference at all.
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

export type InstrumentMatchStatus = 'found' | 'degraded' | 'missing';

export interface InstrumentMatch {
  kind: InstrumentKind;
  /** Human label for the field this reference came from. */
  label: string;
  /** What the profile stores — a device id (picker) or free text. */
  reference: string;
  status: InstrumentMatchStatus;
  /** The matched device's identity and health; all absent when missing. */
  deviceId?: string;
  deviceName?: string;
  deviceState?: BenchDeviceState;
  deviceDetail?: string;
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
    deviceName: device.name,
    deviceState: device.state,
    ...(device.detail !== undefined ? { deviceDetail: device.detail } : {}),
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

// ---------------------------------------------------------------------------
// Copy. The sentences are the distinction, so they are written once here and every
// surface renders the same string for the same state.
// ---------------------------------------------------------------------------

/** The device exists on the bench; the bench says it is unhealthy. Fix: the hardware. */
export function degradedText(
  deviceName: string,
  state: BenchDeviceState,
  detail?: string,
): string {
  const condition = state === 'error' ? 'in error' : 'offline';
  return `${deviceName} is on the bench but ${condition}${detail ? ` (${detail})` : ''}`;
}

/** Nothing on the bench answers to this reference. Fix: the profile. */
export function missingText(reference: string): string {
  return `${reference} was not found on the bench`;
}

/** The state-specific sentence for a match; null when found (a dot says it better). */
export function benchMatchText(match: InstrumentMatch): string | null {
  if (match.status === 'missing') return missingText(match.reference);
  if (match.status === 'degraded') {
    return degradedText(
      match.deviceName ?? match.reference,
      match.deviceState ?? 'offline',
      match.deviceDetail,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// The composer's / gate's warning list (§7.2).
// ---------------------------------------------------------------------------

/**
 * Discriminated on `status`, so the impossible state is unrepresentable rather than
 * merely absent: a missing reference has no device, so it cannot carry a device state
 * for a dot to render (T4.2 review F2).
 */
export type BenchIssue =
  | { key: string; status: 'degraded'; message: string; deviceState: BenchDeviceState }
  | { key: string; status: 'missing'; message: string };

/**
 * Everything about this bench that deserves the operator's attention, in fix-order:
 * first the devices the bench itself reports unhealthy (§7.2's "offline devices" —
 * listed whether or not this profile claims them), then the profile's references that
 * no device answers to. A degraded device the profile also references appears once,
 * as the degraded line: the bench's own report is the more specific fact.
 *
 * `instruments` may be null (no profile selected yet) — then only bench-level degraded
 * devices can be known, which is exactly right: with no profile there is no claim to
 * be missing.
 */
export function benchIssues(
  bench: BenchStatus | null,
  instruments: BoardProfile['instruments'] | null,
): BenchIssue[] {
  if (!bench) return [];

  const issues: BenchIssue[] = bench.devices
    .filter((device) => device.state !== 'online')
    .map((device) => ({
      key: device.id,
      status: 'degraded' as const,
      message: degradedText(device.name, device.state, device.detail),
      deviceState: device.state,
    }));

  if (instruments) {
    for (const match of matchInstruments(instruments, bench)) {
      if (match.status === 'missing') {
        issues.push({
          key: `missing:${match.kind}`,
          status: 'missing',
          message: missingText(match.reference),
        });
      }
    }
  }
  return issues;
}

/** Amber heading: the bench is degraded only when a real device is unhealthy. */
export function benchIssuesTitle(issues: readonly BenchIssue[]): string {
  return issues.some((issue) => issue.status === 'degraded')
    ? 'Bench degraded'
    : 'Bench references not found';
}

// ---------------------------------------------------------------------------
// Home's advisory indicator (§7.1).
// ---------------------------------------------------------------------------

/** How many bench devices are not online. Profile-independent: Home knows no profile. */
export function benchAttentionCount(bench: BenchStatus | null): number {
  return (bench?.devices ?? []).filter((device) => device.state !== 'online').length;
}

export function benchAttentionLabel(count: number): string {
  return count === 1 ? '1 instrument needs attention' : `${count} instruments need attention`;
}
