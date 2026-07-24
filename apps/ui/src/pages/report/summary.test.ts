// Report header summary-row derivation (§7.6, Sprint 7 P1 #9): Run ID · date ·
// iterations, from RunView only. The result/checks dimensions are the dual
// outcome's (outcome.ts); this covers the new metadata row's fields.
import { describe, expect, it } from 'vitest';
import type { RunView } from '@boardex/contract';
import { reportSummary } from './summary';

function view(over: Partial<RunView>): RunView {
  return {
    run: { id: 'run_x' },
    iterations: [],
    ...over,
  } as unknown as RunView;
}

describe('reportSummary (P1 #9)', () => {
  it('slices endedAt to the calendar date and counts the highest iteration', () => {
    expect(
      reportSummary(
        view({
          run: { id: 'run_bme' } as RunView['run'],
          endedAt: '2026-07-07T13:45:12.000Z',
          iterations: [{ iteration: 2, reason: 'applying fix', firstStepIndex: 6 }],
        }),
      ),
    ).toEqual({ runId: 'run_bme', date: '2026-07-07', iterations: 2 });
  });

  it('reports a single iteration when the fix loop never ran', () => {
    expect(reportSummary(view({ endedAt: '2026-07-07T00:00:00Z' }))).toEqual({
      runId: 'run_x',
      date: '2026-07-07',
      iterations: 1,
    });
  });

  it('leaves the date null while the run is non-terminal (no endedAt)', () => {
    expect(reportSummary(view({}))).toEqual({ runId: 'run_x', date: null, iterations: 1 });
  });
});
