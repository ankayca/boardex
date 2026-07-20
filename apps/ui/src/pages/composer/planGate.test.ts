// Checklist progress derivation (Sprint 7 P0): the line and the button copy
// come from one confirmed/total pair, so gate surfaces can never disagree.
import { describe, expect, it } from 'vitest';
import { approvePlanLabel, checklistProgressLine } from './planGate';

describe('checklistProgressLine', () => {
  it('states confirmed over total', () => {
    expect(checklistProgressLine(0, 6)).toBe('0 of 6 bench connections confirmed');
    expect(checklistProgressLine(2, 6)).toBe('2 of 6 bench connections confirmed');
    expect(checklistProgressLine(6, 6)).toBe('6 of 6 bench connections confirmed');
  });
});

describe('approvePlanLabel', () => {
  it('names the remaining gate while incomplete', () => {
    expect(approvePlanLabel(0, 6)).toBe('Approve Plan · 0/6 confirmed');
    expect(approvePlanLabel(2, 6)).toBe('Approve Plan · 2/6 confirmed');
  });

  it('is plain at completion and when no checklist exists', () => {
    expect(approvePlanLabel(6, 6)).toBe('Approve Plan');
    expect(approvePlanLabel(0, 0)).toBe('Approve Plan');
  });
});
