// The Board Profile Builder's form model (BIBLE §7.5), sitting on top of the §4
// BoardProfile contract schema. The draft holds raw input strings (numbers arrive as
// text); validateDraft() converts it and validates the result with the CONTRACT schema
// plus form-only refinements (non-empty text, sane numbers) expressed as a superRefine.
// The refinements never change the shape — the contract stays the authority on fields,
// this module only decides which of them a human may leave blank.
import { z } from 'zod';
import { BoardProfileSchema, type BoardDocument, type BoardProfile } from '@boardex/contract';

/** One connection-checklist row (D12). `key` is client-only, for React + reorder. */
export interface ChecklistRow {
  key: string;
  label: string;
  detail: string;
}

export interface ProfileDraft {
  id: string;
  name: string;
  mcu: string;
  repoPath: string;
  buildCommand: string;
  flashCommand: string;
  resetCommand: string;
  serialPort: string;
  serialBaud: string;
  debugProbe: string;
  /** Optional per §4; blank means "no logic analyzer on this board". */
  logicAnalyzer: string;
  maxIterations: string;
  flashRequiresApproval: boolean;
  powerNote: string;
  checklist: ChecklistRow[];
  /**
   * §7.5 specifies six sections and knownQuirks is in none of them — so the form
   * carries them untouched instead of editing them. Without this, saving an edited
   * profile would blank a field the user never saw.
   */
  knownQuirks: string[];
  /**
   * v2.1 (T6.3): documents have no editing section in Stage 1, so — like
   * knownQuirks — the form carries them untouched instead of blanking a field the
   * user never saw. (The Documents editing section lands in T6.3 stage 2.)
   * Undefined for a profile that carries none.
   */
  documents?: BoardDocument[];
}

let rowSeq = 0;

export function newChecklistRow(): ChecklistRow {
  rowSeq += 1;
  return { key: `row_${rowSeq}`, label: '', detail: '' };
}

/**
 * A fresh profile id. §4: ids are strings (ULID format deliberately not enforced), and
 * POST /board-profiles takes a whole BoardProfile — so a created profile is keyed
 * client-side, exactly as the mock runner keys its runs.
 */
export function newBoardProfileId(): string {
  return `bp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function blankDraft(id: string = newBoardProfileId()): ProfileDraft {
  return {
    id,
    name: '',
    mcu: '',
    repoPath: '',
    buildCommand: '',
    flashCommand: '',
    resetCommand: '',
    serialPort: '',
    serialBaud: '',
    debugProbe: '',
    logicAnalyzer: '',
    maxIterations: '',
    // Fail-closed default: a new board gates its first flash behind a human.
    flashRequiresApproval: true,
    powerNote: '',
    checklist: [],
    knownQuirks: [],
  };
}

export function fromProfile(profile: BoardProfile): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    mcu: profile.mcu,
    repoPath: profile.repoPath,
    buildCommand: profile.buildCommand,
    flashCommand: profile.flashCommand,
    resetCommand: profile.resetCommand,
    serialPort: profile.serial.port,
    serialBaud: String(profile.serial.baud),
    debugProbe: profile.instruments.debugProbe,
    logicAnalyzer: profile.instruments.logicAnalyzer ?? '',
    maxIterations: String(profile.safety.maxIterations),
    flashRequiresApproval: profile.safety.flashRequiresApproval,
    powerNote: profile.safety.powerNote,
    checklist: profile.connectionChecklist.map((row) => ({ ...newChecklistRow(), ...row })),
    knownQuirks: [...profile.knownQuirks],
    documents: profile.documents ? [...profile.documents] : undefined,
  };
}

// --- checklist row operations (pure) ----------------------------------------

export function addChecklistRow(rows: readonly ChecklistRow[]): ChecklistRow[] {
  return [...rows, newChecklistRow()];
}

export function removeChecklistRow(rows: readonly ChecklistRow[], key: string): ChecklistRow[] {
  return rows.filter((row) => row.key !== key);
}

/** Swap a row with its neighbour. A move off either end is a no-op. */
export function moveChecklistRow(
  rows: readonly ChecklistRow[],
  key: string,
  direction: 'up' | 'down',
): ChecklistRow[] {
  const from = rows.findIndex((row) => row.key === key);
  const to = from + (direction === 'up' ? -1 : 1);
  if (from === -1 || to < 0 || to >= rows.length) return [...rows];
  const next = [...rows];
  const moved = next[from] as ChecklistRow;
  next[from] = next[to] as ChecklistRow;
  next[to] = moved;
  return next;
}

// --- validation --------------------------------------------------------------

/** Field errors keyed by the contract path they belong to, e.g. `serial.baud`. */
export type FieldErrors = Record<string, string>;

export type ValidateResult =
  | { ok: true; profile: BoardProfile }
  | { ok: false; errors: FieldErrors };

const REQUIRED = 'Required.';

function requireText(ctx: z.RefinementCtx, value: string, path: (string | number)[]): void {
  if (value.trim().length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: REQUIRED });
  }
}

/**
 * The contract's BoardProfile schema plus the form's own "a human must fill this in"
 * rules. §4 types these fields as plain strings/numbers, so emptiness and positivity
 * are UI concerns, enforced here rather than by widening the contract.
 */
export const ProfileFormSchema = BoardProfileSchema.superRefine((profile, ctx) => {
  requireText(ctx, profile.id, ['id']);
  requireText(ctx, profile.name, ['name']);
  requireText(ctx, profile.mcu, ['mcu']);
  requireText(ctx, profile.repoPath, ['repoPath']);
  requireText(ctx, profile.buildCommand, ['buildCommand']);
  requireText(ctx, profile.flashCommand, ['flashCommand']);
  requireText(ctx, profile.resetCommand, ['resetCommand']);
  requireText(ctx, profile.serial.port, ['serial', 'port']);
  requireText(ctx, profile.instruments.debugProbe, ['instruments', 'debugProbe']);
  requireText(ctx, profile.safety.powerNote, ['safety', 'powerNote']);

  if (profile.serial.baud <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['serial', 'baud'],
      message: 'Enter a baud rate greater than zero.',
    });
  }
  if (profile.safety.maxIterations < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['safety', 'maxIterations'],
      message: 'Allow at least one iteration.',
    });
  }
  profile.connectionChecklist.forEach((row, index) => {
    requireText(ctx, row.label, ['connectionChecklist', index, 'label']);
    requireText(ctx, row.detail, ['connectionChecklist', index, 'detail']);
  });
});

// Whole integers only: a baud rate or iteration cap typed as "115.2k" is a mistake,
// not a rounding opportunity.
function toInt(raw: string): number | null {
  const text = raw.trim();
  return /^-?\d+$/.test(text) ? Number(text) : null;
}

function draftToProfile(draft: ProfileDraft, baud: number, maxIterations: number): BoardProfile {
  const logicAnalyzer = draft.logicAnalyzer.trim();
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    mcu: draft.mcu.trim(),
    repoPath: draft.repoPath.trim(),
    buildCommand: draft.buildCommand.trim(),
    flashCommand: draft.flashCommand.trim(),
    resetCommand: draft.resetCommand.trim(),
    serial: { port: draft.serialPort.trim(), baud },
    instruments: {
      debugProbe: draft.debugProbe.trim(),
      ...(logicAnalyzer ? { logicAnalyzer } : {}),
    },
    safety: {
      maxIterations,
      flashRequiresApproval: draft.flashRequiresApproval,
      powerNote: draft.powerNote.trim(),
    },
    connectionChecklist: draft.checklist.map((row) => ({
      label: row.label.trim(),
      detail: row.detail.trim(),
    })),
    knownQuirks: draft.knownQuirks,
    // Carried untouched (v2.1, T6.3) — omit the key entirely when the profile has
    // no documents, so a documents-less profile round-trips without the field.
    ...(draft.documents ? { documents: draft.documents } : {}),
  };
}

/**
 * Convert + validate a draft. On success the caller holds a contract-valid BoardProfile
 * ready for POST /board-profiles; on failure, one message per offending contract path.
 */
export function validateDraft(draft: ProfileDraft): ValidateResult {
  const errors: FieldErrors = {};

  // Non-numeric text never reaches Zod as a number, so these two get their own
  // message; the schema's own bounds check still runs on the coerced value.
  const baud = toInt(draft.serialBaud);
  if (baud === null) errors['serial.baud'] = 'Enter a whole number, e.g. 115200.';
  const maxIterations = toInt(draft.maxIterations);
  if (maxIterations === null) errors['safety.maxIterations'] = 'Enter a whole number, e.g. 3.';

  const parsed = ProfileFormSchema.safeParse(draftToProfile(draft, baud ?? 0, maxIterations ?? 0));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      if (!(path in errors)) errors[path] = issue.message;
    }
    return { ok: false, errors };
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, profile: parsed.data };
}

/** The instruments a draft references, in the §4 BoardProfile shape. */
export function draftInstruments(draft: ProfileDraft): BoardProfile['instruments'] {
  const logicAnalyzer = draft.logicAnalyzer.trim();
  return {
    debugProbe: draft.debugProbe.trim(),
    ...(logicAnalyzer ? { logicAnalyzer } : {}),
  };
}
