// Quick Start v0: the board profile is COMPILED, not typed (§7.2/§7.5).
//
// Firmware engineers were being asked for MCU part numbers, flash invocations and
// instrument ids — while every one of those answers already lives in the bench scan,
// the repo, or the prompt. So Quick Start asks for two things (a repo path and the
// task) and assembles the rest here, from the live GET /bench snapshot plus the path
// probe's detected build command. Everything it writes stays editable in the full
// builder ("Advanced"); nothing here is invented beyond the documented defaults below.
import type { BenchStatus, BoardProfile } from '@boardex/contract';
import { repoBasename } from '../../lib/repoBasename';
import { newBoardProfileId } from '../boards/profileDraft';

/** Fallback when the runner cannot tell us (route absent, or no build file found). */
export const DEFAULT_BUILD_COMMAND = 'make';

/** §7.5 Serial defaults — the ST-Link VCP port every bench board on this bench uses. */
export const DEFAULT_SERIAL = { port: '/dev/ttyACM0', baud: 115200 } as const;

/**
 * D12, Kerem's 2026-07-28 ruling: Quick Start seeds ONLY universal bench
 * preconditions — three rows that are questions the operator answers, not facts we
 * fabricated about their wiring. Board-specific rows (pin names, sensor lines) stay
 * human- or agent-authored: inventing those is the line D12 must not cross. The panel
 * says so in copy ("generic defaults — refine in Advanced").
 */
export const QUICK_START_CHECKLIST: readonly { label: string; detail: string }[] = [
  {
    label: 'Board powered (3V3/5V confirmed)',
    detail: 'The board is powered and its supply rail measures the expected voltage.',
  },
  {
    label: 'Debug probe connected',
    detail: 'The debug probe is attached to the target and enumerated on the runner host.',
  },
  {
    label: 'Serial cable connected',
    detail: 'The serial cable is connected and its port appears on the runner host.',
  },
];

/** Same class as the checklist rows: a manual-power precondition (D11), not a fact. */
export const QUICK_START_POWER_NOTE =
  'Manual power: confirm the board is powered before the run.';

export interface QuickStartInput {
  /** The path as validated — the typed one, or a suggestedPath the user accepted. */
  repoPath: string;
  /** Editable in the panel footer; defaults to the repo folder name. */
  name: string;
  /** From the path probe; absent when the route is unsupported or found no build file. */
  detectedBuild?: string | undefined;
  /** The live bench scan. Null (or device-less) is fine — see below. */
  bench: BenchStatus | null;
}

/** The board name Quick Start derives from a path: its folder. */
export function quickStartName(repoPath: string): string {
  return repoBasename(repoPath.trim().replace(/\/+$/, '')) || 'New board';
}

function firstDeviceId(bench: BenchStatus | null, kind: 'debug_probe' | 'logic_analyzer'):
  | string
  | undefined {
  // The device's stable registry id (§4), which is exactly what the builder's
  // detected-device picker writes — so a compiled profile resolves against the bench
  // the same way a hand-picked one does. State is not filtered on: an offline probe is
  // still the probe on this bench, and the standing bench advisory reports its health.
  return bench?.devices.find((device) => device.kind === kind)?.id;
}

/** What the bench says this probe is attached to, e.g. "stm32f303retx". */
function benchTarget(bench: BenchStatus | null): string | undefined {
  const detail = bench?.devices.find((device) => device.kind === 'debug_probe')?.detail?.trim();
  return detail && detail.length > 0 ? detail : undefined;
}

/**
 * Compile a BoardProfile from a path + the bench. Deterministic and pure — the id is
 * the only injected value, so tests assert the whole object.
 *
 * Flash/reset are templated on the bench-reported target when there is one; with no
 * target they fall back to generic pyocd invocations that name no device we have not
 * seen. mcu carries the bench-reported target verbatim (it is what the bench knows,
 * not a datasheet part name) and stays empty when the bench reports nothing —
 * never an assumed anything.
 */
export function buildQuickStartProfile(
  input: QuickStartInput,
  id: string = newBoardProfileId(),
): BoardProfile {
  const target = benchTarget(input.bench);
  const logicAnalyzer = firstDeviceId(input.bench, 'logic_analyzer');
  const repoPath = input.repoPath.trim().replace(/\/+$/, '');

  return {
    id,
    name: input.name.trim() || quickStartName(repoPath),
    mcu: target ?? '',
    repoPath,
    buildCommand: input.detectedBuild?.trim() || DEFAULT_BUILD_COMMAND,
    flashCommand: target ? `pyocd flash --target ${target} firmware.elf` : 'pyocd flash firmware.elf',
    resetCommand: target ? `pyocd reset --target ${target}` : 'pyocd reset',
    serial: { ...DEFAULT_SERIAL },
    instruments: {
      // Empty when the bench reports no probe: the profile claims nothing rather than
      // naming a device that is not there (§7.2's "never an assumed anything").
      debugProbe: firstDeviceId(input.bench, 'debug_probe') ?? '',
      ...(logicAnalyzer ? { logicAnalyzer } : {}),
    },
    safety: {
      maxIterations: 3,
      // Fail-closed, same default as a blank builder draft: a new board gates its
      // first flash behind a human.
      flashRequiresApproval: true,
      powerNote: QUICK_START_POWER_NOTE,
    },
    connectionChecklist: QUICK_START_CHECKLIST.map((row) => ({ ...row })),
    knownQuirks: [],
  };
}
