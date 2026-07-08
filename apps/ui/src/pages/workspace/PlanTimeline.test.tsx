// Center-zone behaviors (T2.1): the iteration divider renders on
// run.iteration_started and sits before the iteration-2 steps; the active step is
// auto-expanded with its per-stream log pane while completed steps stay collapsed
// until toggled; the task prompt starts collapsed and expands.
import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Event } from '@boardex/contract';
import { PlanTimeline } from './PlanTimeline';
import { envelope, planStep, run, runStep, viewFrom } from './test-events';

// jsdom reports zero offset sizes, so the virtualizer would render no log rows at
// all (same shim as LogViewer.test.tsx).
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 640,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 200,
  });
});

// A run mid-iteration-2, reduced by the real reducer: iteration-1 validate failed,
// the fix loop started, and the iteration-2 edit step is active with agent logs.
function iterationTwoEvents(): Event[] {
  return [
    envelope(1, 'run.created', { run }),
    envelope(2, 'run.plan_generated', {
      plan: [planStep(0, 'Modify firmware'), planStep(1, 'Validate')],
      riskSummary: 'low',
    }),
    envelope(3, 'step.started', { step: runStep('st_eval1', 1, 'Validate measurements') }),
    envelope(4, 'step.log', { stepId: 'st_eval1', stream: 'agent', line: 'Evaluating checks…' }),
    envelope(5, 'step.failed', { stepId: 'st_eval1', summary: 'device_ack failed', artifactIds: [] }),
    envelope(6, 'run.iteration_started', { iteration: 2, reason: 'applying the address fix' }),
    envelope(7, 'step.started', { step: runStep('st_edit2', 0, 'Apply I2C address fix') }),
    envelope(8, 'step.log', { stepId: 'st_edit2', stream: 'agent', line: 'Rewriting BME280_ADDR…' }),
    envelope(9, 'step.log', { stepId: 'st_edit2', stream: 'build', line: 'CC bme280.o' }),
  ];
}

describe('PlanTimeline', () => {
  it('renders the iteration divider before the iteration-2 steps', () => {
    render(<PlanTimeline view={viewFrom(iterationTwoEvents())} />);

    const rows = within(screen.getByRole('list', { name: 'Run timeline' })).getAllByRole(
      'listitem',
    );
    const texts = rows.map((row) => row.textContent ?? '');
    const dividerIndex = texts.findIndex((text) => text.includes('Iteration 2 — applying fix'));
    const iter1Index = texts.findIndex((text) => text.includes('Validate measurements'));
    const iter2Index = texts.findIndex((text) => text.includes('Apply I2C address fix'));

    expect(dividerIndex).toBeGreaterThan(iter1Index);
    expect(dividerIndex).toBeLessThan(iter2Index);
    // The divider surfaces the run.iteration_started reason.
    expect(texts[dividerIndex]).toContain('applying the address fix');
  });

  it('renders no divider before run.iteration_started arrives', () => {
    render(<PlanTimeline view={viewFrom(iterationTwoEvents().slice(0, 5))} />);
    expect(screen.queryByText(/Iteration 2/)).not.toBeInTheDocument();
  });

  it('auto-expands only the active step; a completed step expands on toggle', async () => {
    const user = userEvent.setup();
    render(<PlanTimeline view={viewFrom(iterationTwoEvents())} />);

    // Active iteration-2 step: expanded, logs routed to their streams.
    const activeToggle = screen.getByRole('button', { name: /Apply I2C address fix/ });
    expect(activeToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('log', { name: 'Apply I2C address fix — Agent log' })).toHaveTextContent(
      'Rewriting BME280_ADDR…',
    );

    // Failed iteration-1 step: collapsed until the user opens it.
    const failedToggle = screen.getByRole('button', { name: /Validate measurements/ });
    expect(failedToggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(failedToggle);
    expect(failedToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('device_ack failed')).toBeInTheDocument();
    expect(
      screen.getByRole('log', { name: 'Validate measurements — Agent log' }),
    ).toHaveTextContent('Evaluating checks…');
  });

  it('collapses the task prompt to two lines and expands on demand', async () => {
    const user = userEvent.setup();
    render(<PlanTimeline view={viewFrom(iterationTwoEvents())} />);

    const prompt = screen.getByText(run.taskPrompt);
    expect(prompt.className).toContain('line-clamp-2');
    await user.click(screen.getByRole('button', { name: 'Show full task' }));
    expect(prompt.className).not.toContain('line-clamp-2');
  });
});
