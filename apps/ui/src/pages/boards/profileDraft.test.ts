// The form model: contract-schema validation per §7.5 section, and the checklist row
// operations the editor is built on. These assert behavior (which path errors, what a
// valid draft becomes) rather than that the functions run.
import { describe, expect, it } from 'vitest';
import { BoardProfileSchema, type BoardProfile } from '@boardex/contract';
import {
  addChecklistRow,
  blankDraft,
  fromProfile,
  moveChecklistRow,
  newBoardProfileId,
  newChecklistRow,
  removeChecklistRow,
  validateDraft,
  type ChecklistRow,
  type ProfileDraft,
} from './profileDraft';

const FULL: BoardProfile = BoardProfileSchema.parse({
  id: 'bp_test',
  name: 'Nucleo-F303RE',
  mcu: 'STM32F303RE (Cortex-M4)',
  repoPath: '/bench/firmware/bme280-f303re',
  buildCommand: 'make clean && make',
  flashCommand: 'pyocd flash --target stm32f303retx bme280.elf',
  resetCommand: 'pyocd reset --target stm32f303retx',
  serial: { port: '/dev/ttyACM0', baud: 115200 },
  instruments: {
    debugProbe: 'pyocd:stlink:066EFF383733554157254923',
    logicAnalyzer: 'sigrok:kingst-la2016:conn=3.12',
  },
  safety: { maxIterations: 3, flashRequiresApproval: true, powerNote: '3V3 confirmed.' },
  connectionChecklist: [{ label: 'SCL — PB8', detail: 'PB8 to BME280 SCL' }],
  knownQuirks: ['BMP280 clones report chip id 0x58.'],
});

const validDraft = (): ProfileDraft => fromProfile(FULL);

function errorsOf(draft: ProfileDraft): Record<string, string> {
  const result = validateDraft(draft);
  if (result.ok) throw new Error('expected the draft to be invalid');
  return result.errors;
}

describe('validateDraft — a complete draft', () => {
  it('round-trips a profile through the form model unchanged', () => {
    const result = validateDraft(validDraft());
    expect(result).toEqual({ ok: true, profile: FULL });
  });

  it('trims whitespace and drops a blank logic analyzer (optional per §4)', () => {
    const result = validateDraft({
      ...validDraft(),
      name: '  Nucleo-F303RE  ',
      logicAnalyzer: '   ',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.name).toBe('Nucleo-F303RE');
    expect(result.profile.instruments).not.toHaveProperty('logicAnalyzer');
  });

  it('preserves knownQuirks, which §7.5 gives no section and the form never shows', () => {
    const result = validateDraft(validDraft());
    expect(result.ok && result.profile.knownQuirks).toEqual(FULL.knownQuirks);
  });

  // v2.1 (T6.3): documents have no editing section in stage 1, so the form must
  // carry them untouched — saving an edited profile can't drop the field.
  it('carries documents (v2.1) through untouched, and omits the key when there are none', () => {
    const withDocs = {
      ...FULL,
      documents: [
        { id: 'doc_bme280_datasheet', label: 'BME280 datasheet', kind: 'datasheet', mimeType: 'text/markdown' },
      ] as const,
    };
    const kept = validateDraft(fromProfile({ ...withDocs, documents: [...withDocs.documents] }));
    expect(kept.ok && kept.profile.documents).toEqual(withDocs.documents);

    // A documents-less profile round-trips with no documents key at all.
    const none = validateDraft(validDraft());
    expect(none.ok && 'documents' in none.profile).toBe(false);
  });
});

describe('validateDraft — required fields, per §7.5 section', () => {
  it.each([
    ['Identity', 'name', 'name'],
    ['Identity', 'mcu', 'mcu'],
    ['Firmware', 'repoPath', 'repoPath'],
    ['Firmware', 'buildCommand', 'buildCommand'],
    ['Firmware', 'flashCommand', 'flashCommand'],
    ['Firmware', 'resetCommand', 'resetCommand'],
    ['Serial', 'serialPort', 'serial.port'],
    ['Instruments', 'debugProbe', 'instruments.debugProbe'],
    ['Safety', 'powerNote', 'safety.powerNote'],
  ] as const)('%s: a blank %s errors at the contract path %s', (_section, field, path) => {
    expect(errorsOf({ ...validDraft(), [field]: '   ' })).toHaveProperty(path);
  });

  it('Instruments: the logic analyzer stays optional', () => {
    expect(validateDraft({ ...validDraft(), logicAnalyzer: '' }).ok).toBe(true);
  });

  it.each(['', 'abc', '115.2k', '11 5200'])('Serial: baud %j is not a whole number', (baud) => {
    expect(errorsOf({ ...validDraft(), serialBaud: baud })['serial.baud']).toMatch(/whole number/);
  });

  it('Serial: a non-positive baud is rejected by the contract refinement', () => {
    expect(errorsOf({ ...validDraft(), serialBaud: '0' })['serial.baud']).toMatch(
      /greater than zero/,
    );
  });

  it.each(['', 'three', '2.5'])('Safety: maxIterations %j is not a whole number', (value) => {
    expect(errorsOf({ ...validDraft(), maxIterations: value })['safety.maxIterations']).toMatch(
      /whole number/,
    );
  });

  it('Safety: fewer than one iteration is rejected', () => {
    expect(errorsOf({ ...validDraft(), maxIterations: '0' })['safety.maxIterations']).toMatch(
      /at least one/,
    );
  });

  it('Safety: flashRequiresApproval=false is valid, and defaults to true on a new profile', () => {
    expect(validateDraft({ ...validDraft(), flashRequiresApproval: false }).ok).toBe(true);
    expect(blankDraft().flashRequiresApproval).toBe(true);
  });

  it('Checklist: a blank row errors on both of its fields, indexed', () => {
    const draft = validDraft();
    const errors = errorsOf({
      ...draft,
      checklist: [...draft.checklist, { ...newChecklistRow(), label: ' ', detail: '' }],
    });
    expect(errors['connectionChecklist.1.label']).toBe('Required.');
    expect(errors['connectionChecklist.1.detail']).toBe('Required.');
    // The good first row is not blamed for the bad second one.
    expect(errors).not.toHaveProperty('connectionChecklist.0.label');
  });

  it('Checklist: an empty checklist is valid (§4 allows it; the pre-run gate is then empty)', () => {
    expect(validateDraft({ ...validDraft(), checklist: [] }).ok).toBe(true);
  });

  it('reports every offending field at once, not just the first', () => {
    const errors = errorsOf({ ...blankDraft('bp_x'), serialBaud: '', maxIterations: '' });
    expect(Object.keys(errors).sort()).toEqual([
      'buildCommand',
      'flashCommand',
      'instruments.debugProbe',
      'mcu',
      'name',
      'repoPath',
      'resetCommand',
      'safety.maxIterations',
      'safety.powerNote',
      'serial.baud',
      'serial.port',
    ]);
  });
});

describe('newBoardProfileId', () => {
  it('mints distinct, non-empty ids that satisfy the contract schema', () => {
    const a = newBoardProfileId();
    const b = newBoardProfileId();
    expect(a).not.toBe(b);
    expect(validateDraft({ ...validDraft(), id: a }).ok).toBe(true);
  });
});

describe('checklist row operations', () => {
  const rows = (): ChecklistRow[] => [
    { key: 'a', label: 'SCL', detail: 'PB8' },
    { key: 'b', label: 'SDA', detail: 'PB9' },
    { key: 'c', label: 'GND', detail: 'GND' },
  ];
  const labels = (list: readonly ChecklistRow[]) => list.map((row) => row.label);

  it('adds one blank row at the end with a fresh key', () => {
    const next = addChecklistRow(rows());
    expect(next).toHaveLength(4);
    expect(next[3]).toMatchObject({ label: '', detail: '' });
    expect(new Set(next.map((row) => row.key)).size).toBe(4);
  });

  it('removes by key and leaves the rest in order', () => {
    expect(labels(removeChecklistRow(rows(), 'b'))).toEqual(['SCL', 'GND']);
  });

  it('removing an unknown key changes nothing', () => {
    expect(labels(removeChecklistRow(rows(), 'zzz'))).toEqual(['SCL', 'SDA', 'GND']);
  });

  it('moves a row up and down by swapping with its neighbour', () => {
    expect(labels(moveChecklistRow(rows(), 'b', 'up'))).toEqual(['SDA', 'SCL', 'GND']);
    expect(labels(moveChecklistRow(rows(), 'b', 'down'))).toEqual(['SCL', 'GND', 'SDA']);
  });

  it('a move off either end is a no-op', () => {
    expect(labels(moveChecklistRow(rows(), 'a', 'up'))).toEqual(['SCL', 'SDA', 'GND']);
    expect(labels(moveChecklistRow(rows(), 'c', 'down'))).toEqual(['SCL', 'SDA', 'GND']);
  });

  it('moves are pure — the input array is untouched', () => {
    const original = rows();
    moveChecklistRow(original, 'a', 'down');
    expect(labels(original)).toEqual(['SCL', 'SDA', 'GND']);
  });

  it('a reordered checklist saves in its new order', () => {
    const draft = { ...validDraft(), checklist: rows() };
    const result = validateDraft({ ...draft, checklist: moveChecklistRow(draft.checklist, 'c', 'up') });
    expect(result.ok && result.profile.connectionChecklist.map((row) => row.label)).toEqual([
      'SCL',
      'GND',
      'SDA',
    ]);
  });
});
