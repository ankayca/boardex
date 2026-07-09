// Rollback affordance derivation (§7.4): enabled for every non-terminal status,
// disabled with an explanatory tooltip for every terminal one.
import { describe, expect, it } from 'vitest';
import type { RunStatus } from '@boardex/contract';
import { rollbackEnabled, rollbackTooltip } from './rollback';

const NON_TERMINAL: RunStatus[] = [
  'draft',
  'planning',
  'plan_ready',
  'running',
  'awaiting_approval',
  'diagnosing',
];
const TERMINAL: RunStatus[] = ['completed', 'failed', 'stopped'];

describe('rollbackEnabled', () => {
  it('is enabled for every non-terminal status', () => {
    for (const status of NON_TERMINAL) expect(rollbackEnabled(status)).toBe(true);
  });

  it('is disabled for every terminal status', () => {
    for (const status of TERMINAL) expect(rollbackEnabled(status)).toBe(false);
  });
});

describe('rollbackTooltip', () => {
  it('explains why when disabled, naming the terminal status', () => {
    expect(rollbackTooltip('completed')).toMatch(/completed.*only available while a run is active/);
  });

  it('describes the runner-side revert when enabled', () => {
    expect(rollbackTooltip('running')).toMatch(/runner/i);
  });
});
