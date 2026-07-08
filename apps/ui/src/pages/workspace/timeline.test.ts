// Timeline state derivation from the store's reduced view (T2.1): executed steps in
// start order, pending plan rows for unexecuted plan indices merged in at their
// plan-index position, iteration dividers at the reducer's marker positions.
import { describe, expect, it } from 'vitest';
import { deriveTimeline } from './timeline';
import { envelope, planStep, run, runStep, viewFrom } from './test-events';

const PLAN = [
  planStep(0, 'Understand context'),
  planStep(1, 'Modify firmware'),
  planStep(2, 'Build & flash'),
  planStep(3, 'Validate'),
];

const planned = (events: Parameters<typeof viewFrom>[0]) => deriveTimeline(viewFrom(events));

describe('deriveTimeline', () => {
  it('renders the whole plan as pending rows before any step starts', () => {
    const items = planned([
      envelope(1, 'run.created', { run }),
      envelope(2, 'run.plan_generated', { plan: PLAN, riskSummary: 'low' }),
    ]);
    expect(items).toEqual(
      PLAN.map((step) => ({ kind: 'planned', planStep: step })),
    );
  });

  it('replaces a pending plan row with the executed step that carries its planIndex', () => {
    const items = planned([
      envelope(1, 'run.created', { run }),
      envelope(2, 'run.plan_generated', { plan: PLAN, riskSummary: 'low' }),
      envelope(3, 'step.started', { step: runStep('st_ctx', 0, 'Understand context') }),
    ]);
    expect(items[0]).toMatchObject({ kind: 'executed', step: { id: 'st_ctx', status: 'active' } });
    // Plan index 0 is executed; 1..3 remain pending, in plan order.
    expect(items.slice(1)).toEqual(PLAN.slice(1).map((step) => ({ kind: 'planned', planStep: step })));
  });

  it('keeps both executed steps when two run steps share one plan index (§7.3 build & flash)', () => {
    const items = planned([
      envelope(1, 'run.created', { run }),
      envelope(2, 'run.plan_generated', { plan: PLAN, riskSummary: 'low' }),
      envelope(3, 'step.started', { step: runStep('st_build', 2, 'Build firmware') }),
      envelope(4, 'step.completed', { stepId: 'st_build', summary: 'ok', artifactIds: [] }),
      envelope(5, 'step.started', { step: runStep('st_flash', 2, 'Flash firmware') }),
    ]);
    // Unexecuted indices 0 and 1 sit at their plan position, above the index-2 rows.
    expect(items.map((item) => item.kind)).toEqual([
      'planned',
      'planned',
      'executed',
      'executed',
      'planned',
    ]);
    expect(items[0]).toMatchObject({ planStep: { index: 0 } });
    expect(items[1]).toMatchObject({ planStep: { index: 1 } });
    expect(items[2]).toMatchObject({ step: { id: 'st_build', status: 'succeeded' } });
    expect(items[3]).toMatchObject({ step: { id: 'st_flash', status: 'active' } });
    expect(items[4]).toMatchObject({ planStep: { index: 3 } });
  });

  it('renders a skipped plan index as Pending above later executed steps, never below', () => {
    // Plan 0..3 where index 0 never ran while 1 and 2 did (review finding 1).
    const items = planned([
      envelope(1, 'run.created', { run }),
      envelope(2, 'run.plan_generated', { plan: PLAN, riskSummary: 'low' }),
      envelope(3, 'step.started', { step: runStep('st_edit', 1, 'Modify firmware') }),
      envelope(4, 'step.completed', { stepId: 'st_edit', summary: 'ok', artifactIds: [] }),
      envelope(5, 'step.started', { step: runStep('st_build', 2, 'Build firmware') }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(['planned', 'executed', 'executed', 'planned']);
    expect(items[0]).toMatchObject({ planStep: { index: 0 } });
    expect(items[1]).toMatchObject({ step: { id: 'st_edit', status: 'succeeded' } });
    expect(items[2]).toMatchObject({ step: { id: 'st_build', status: 'active' } });
    expect(items[3]).toMatchObject({ planStep: { index: 3 } });
  });

  it('carries the step status through (succeeded / failed / active)', () => {
    const items = planned([
      envelope(1, 'run.created', { run }),
      envelope(2, 'step.started', { step: runStep('st_a', 0, 'A') }),
      envelope(3, 'step.failed', { stepId: 'st_a', summary: 'NACK at 0x76', artifactIds: [] }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'executed',
      step: { status: 'failed', summary: 'NACK at 0x76' },
    });
  });

  it('inserts the iteration divider exactly before the first iteration-2 step', () => {
    const items = planned([
      envelope(1, 'run.created', { run }),
      envelope(2, 'run.plan_generated', { plan: PLAN, riskSummary: 'low' }),
      envelope(3, 'step.started', { step: runStep('st_eval', 3, 'Validate') }),
      envelope(4, 'step.failed', { stepId: 'st_eval', summary: 'checks failed', artifactIds: [] }),
      envelope(5, 'run.iteration_started', { iteration: 2, reason: 'applying address fix' }),
      envelope(6, 'step.started', { step: runStep('st_edit2', 1, 'Apply I2C address fix') }),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      'planned', // plan 0 (never ran; plan position above the index-3 row)
      'planned', // plan 2 (same)
      'executed', // st_eval (failed)
      'iteration',
      'executed', // st_edit2
    ]);
    expect(items[3]).toEqual({ kind: 'iteration', iteration: 2, reason: 'applying address fix' });
  });

  it('re-executing a plan index in iteration 2 keeps both executed rows around the divider', () => {
    // Review finding 3: iteration 1 runs plan index 2 and fails; iteration 2 re-runs
    // index 2. No duplicate Pending row for index 2, no orphaned rows.
    const items = planned([
      envelope(1, 'run.created', { run }),
      envelope(2, 'run.plan_generated', { plan: PLAN, riskSummary: 'low' }),
      envelope(3, 'step.started', { step: runStep('st_ctx', 0, 'Understand context') }),
      envelope(4, 'step.completed', { stepId: 'st_ctx', summary: 'ok', artifactIds: [] }),
      envelope(5, 'step.started', { step: runStep('st_edit', 1, 'Modify firmware') }),
      envelope(6, 'step.completed', { stepId: 'st_edit', summary: 'ok', artifactIds: [] }),
      envelope(7, 'step.started', { step: runStep('st_build1', 2, 'Build & flash') }),
      envelope(8, 'step.failed', { stepId: 'st_build1', summary: 'link failed', artifactIds: [] }),
      envelope(9, 'run.iteration_started', { iteration: 2, reason: 'fixing the linker script' }),
      envelope(10, 'step.started', { step: runStep('st_build2', 2, 'Build & flash (iteration 2)') }),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      'executed', // st_ctx
      'executed', // st_edit
      'executed', // st_build1 (failed)
      'iteration',
      'executed', // st_build2
      'planned', // plan 3 — the only pending row; index 2 does not reappear
    ]);
    expect(items[2]).toMatchObject({ step: { id: 'st_build1', status: 'failed', planIndex: 2 } });
    expect(items[4]).toMatchObject({ step: { id: 'st_build2', status: 'active', planIndex: 2 } });
    expect(items[5]).toMatchObject({ planStep: { index: 3 } });
    expect(items).toHaveLength(6);
  });

  it('places a divider whose first step has not started yet after the executed steps', () => {
    const items = planned([
      envelope(1, 'run.created', { run }),
      envelope(2, 'step.started', { step: runStep('st_a', 0, 'A') }),
      envelope(3, 'step.failed', { stepId: 'st_a', summary: 'failed', artifactIds: [] }),
      envelope(4, 'run.iteration_started', { iteration: 2, reason: 'retrying' }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(['executed', 'iteration']);
  });
});
