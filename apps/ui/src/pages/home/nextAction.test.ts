import { describe, expect, it } from 'vitest';
import type { RunStatus, RunSummary } from '@boardex/contract';
import {
  compareRunSummaries,
  nextAction,
  runAttention,
  sortRunSummaries,
} from './nextAction';

const ALL_STATUSES: RunStatus[] = [
  'draft',
  'planning',
  'plan_ready',
  'running',
  'awaiting_approval',
  'diagnosing',
  'completed',
  'failed',
  'stopped',
];

describe('nextAction (BIBLE §7.1)', () => {
  it('maps the human-action states to the spec labels', () => {
    expect(nextAction('plan_ready', 'r1')).toEqual({ label: 'Approve plan', route: '/runs/r1' });
    // "Review approval" since T5.0 (§7.1 v2.0): the row cannot know WHICH approval
    // is pending, so the label names the user's action, not a guessed proposal.
    expect(nextAction('awaiting_approval', 'r1')).toEqual({
      label: 'Review approval',
      route: '/runs/r1',
    });
  });

  it('maps terminal states to their evidence/report actions', () => {
    expect(nextAction('completed', 'r2').label).toBe('Open report');
    expect(nextAction('failed', 'r2').label).toBe('View evidence');
    expect(nextAction('stopped', 'r2').label).toBe('View evidence');
  });

  it('gives in-flight states a neutral "View run"', () => {
    for (const status of ['draft', 'planning', 'running', 'diagnosing'] as RunStatus[]) {
      expect(nextAction(status, 'r3').label).toBe('View run');
    }
  });

  it('always routes to the run workspace and never leaves a label blank', () => {
    for (const status of ALL_STATUSES) {
      const action = nextAction(status, 'abc');
      expect(action.route).toBe('/runs/abc');
      expect(action.label.length).toBeGreaterThan(0);
    }
  });
});

describe('runAttention buckets (§7.1)', () => {
  it('flags exactly the two amber human-action states as needs-attention', () => {
    const attention = ALL_STATUSES.filter((s) => runAttention(s) === 'needs-attention');
    expect(attention.sort()).toEqual(['awaiting_approval', 'plan_ready']);
  });

  it('flags the three terminal states as recent', () => {
    const recent = ALL_STATUSES.filter((s) => runAttention(s) === 'recent');
    expect(recent.sort()).toEqual(['completed', 'failed', 'stopped']);
  });

  it('treats every remaining state as active', () => {
    const active = ALL_STATUSES.filter((s) => runAttention(s) === 'active');
    expect(active.sort()).toEqual(['diagnosing', 'draft', 'planning', 'running']);
  });
});

function run(partial: Partial<RunSummary> & Pick<RunSummary, 'id' | 'status' | 'updatedAt'>): RunSummary {
  return { title: partial.id, boardProfileId: 'bp', ...partial };
}

describe('run ordering (§7.1: needs-attention → active → recent, then recency)', () => {
  it('orders across buckets regardless of timestamp', () => {
    const runs: RunSummary[] = [
      run({ id: 'done', status: 'completed', updatedAt: '2026-07-07T12:00:00.000Z' }),
      run({ id: 'busy', status: 'running', updatedAt: '2026-07-07T09:00:00.000Z' }),
      run({ id: 'needsme', status: 'awaiting_approval', updatedAt: '2026-07-07T06:00:00.000Z' }),
    ];
    expect(sortRunSummaries(runs).map((r) => r.id)).toEqual(['needsme', 'busy', 'done']);
  });

  it('breaks ties within a bucket by most-recently-updated first', () => {
    const runs: RunSummary[] = [
      run({ id: 'older', status: 'awaiting_approval', updatedAt: '2026-07-07T06:00:00.000Z' }),
      run({ id: 'newer', status: 'plan_ready', updatedAt: '2026-07-07T08:00:00.000Z' }),
    ];
    expect(sortRunSummaries(runs).map((r) => r.id)).toEqual(['newer', 'older']);
  });

  it('does not mutate the input array', () => {
    const runs: RunSummary[] = [
      run({ id: 'a', status: 'completed', updatedAt: '2026-07-07T12:00:00.000Z' }),
      run({ id: 'b', status: 'plan_ready', updatedAt: '2026-07-07T06:00:00.000Z' }),
    ];
    const before = runs.map((r) => r.id);
    sortRunSummaries(runs);
    expect(runs.map((r) => r.id)).toEqual(before);
  });

  it('compareRunSummaries is consistent with the sorted output', () => {
    const a = run({ id: 'a', status: 'plan_ready', updatedAt: '2026-07-07T06:00:00.000Z' });
    const b = run({ id: 'b', status: 'running', updatedAt: '2026-07-07T09:00:00.000Z' });
    expect(compareRunSummaries(a, b)).toBeLessThan(0);
    expect(compareRunSummaries(b, a)).toBeGreaterThan(0);
  });
});
