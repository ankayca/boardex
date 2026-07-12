import { describe, expect, it } from 'vitest';
import { deriveProgress } from './progress';
import { envelope, planStep, run, runStep, viewFrom } from './test-events';

const PLAN = [
  planStep(0, 'Understand context'),
  planStep(1, 'Modify firmware'),
  planStep(2, 'Build & flash'),
  planStep(3, 'Validate'),
];

const planned = () => [
  envelope(1, 'run.created', { run }),
  envelope(2, 'run.plan_generated', { plan: PLAN, riskSummary: 'low' }),
];

describe('deriveProgress', () => {
  it('is 0 of 0 before a plan exists', () => {
    const view = viewFrom([envelope(1, 'run.created', { run })]);
    expect(deriveProgress(view)).toEqual({ completed: 0, total: 0 });
  });

  it('counts only succeeded plan indices against plan length', () => {
    const view = viewFrom([
      ...planned(),
      envelope(3, 'step.started', { step: runStep('st0', 0, 'Understand') }),
      envelope(4, 'step.completed', { stepId: 'st0', summary: 'done', artifactIds: [] }),
      envelope(5, 'step.started', { step: runStep('st1', 1, 'Modify') }), // still active
    ]);
    expect(deriveProgress(view)).toEqual({ completed: 1, total: 4 });
  });

  it('does not count a failed step', () => {
    const view = viewFrom([
      ...planned(),
      envelope(3, 'step.started', { step: runStep('st0', 0, 'Understand') }),
      envelope(4, 'step.failed', { stepId: 'st0', summary: 'nope', artifactIds: [] }),
    ]);
    expect(deriveProgress(view)).toEqual({ completed: 0, total: 4 });
  });

  it('counts a plan index once when two run steps share it (build & flash)', () => {
    const view = viewFrom([
      ...planned(),
      envelope(3, 'step.started', { step: runStep('build', 2, 'Build') }),
      envelope(4, 'step.completed', { stepId: 'build', summary: 'built', artifactIds: [] }),
      envelope(5, 'step.started', { step: runStep('flash', 2, 'Flash') }),
      envelope(6, 'step.completed', { stepId: 'flash', summary: 'flashed', artifactIds: [] }),
    ]);
    expect(deriveProgress(view)).toEqual({ completed: 1, total: 4 });
  });

  it('latest-execution-wins: an iteration-2 re-run that succeeds counts the index', () => {
    const view = viewFrom([
      ...planned(),
      envelope(3, 'step.started', { step: runStep('s1a', 1, 'Modify') }),
      envelope(4, 'step.failed', { stepId: 's1a', summary: 'bad', artifactIds: [] }),
      envelope(5, 'run.iteration_started', { iteration: 2, reason: 'applying fix' }),
      envelope(6, 'step.started', { step: runStep('s1b', 1, 'Modify again') }),
      envelope(7, 'step.completed', { stepId: 's1b', summary: 'fixed', artifactIds: [] }),
    ]);
    expect(deriveProgress(view)).toEqual({ completed: 1, total: 4 });
  });

  it('latest-execution-wins: a re-opened index drops back out of the count', () => {
    const view = viewFrom([
      ...planned(),
      envelope(3, 'step.started', { step: runStep('s1a', 1, 'Modify') }),
      envelope(4, 'step.completed', { stepId: 's1a', summary: 'ok', artifactIds: [] }),
      // Same plan index re-executed and still active — latest status is not succeeded.
      envelope(5, 'step.started', { step: runStep('s1b', 1, 'Modify again') }),
    ]);
    expect(deriveProgress(view)).toEqual({ completed: 0, total: 4 });
  });
});
