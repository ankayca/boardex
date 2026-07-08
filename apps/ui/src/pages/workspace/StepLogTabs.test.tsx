// Log-tab routing per stream (T2.1): every §5.2 stream gets a tab, and each tab's
// pane shows exactly the lines that arrived on that stream, in order.
import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StepLogLine } from '@boardex/contract';
import { linesForStream } from './logStreams';
import { StepLogTabs } from './StepLogTabs';

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

const LOGS: readonly StepLogLine[] = [
  { stream: 'agent', line: 'Flashing firmware via pyOCD…' },
  { stream: 'flash', line: '[pyocd] erased 2 sectors' },
  { stream: 'agent', line: 'Flash complete, resetting target.' },
  { stream: 'serial', line: 'TEMP=24.3 HUM=41.2' },
];

describe('linesForStream', () => {
  it('routes each line to its stream, preserving arrival order', () => {
    expect(linesForStream(LOGS, 'agent')).toEqual([
      'Flashing firmware via pyOCD…',
      'Flash complete, resetting target.',
    ]);
    expect(linesForStream(LOGS, 'flash')).toEqual(['[pyocd] erased 2 sectors']);
    expect(linesForStream(LOGS, 'serial')).toEqual(['TEMP=24.3 HUM=41.2']);
    expect(linesForStream(LOGS, 'build')).toEqual([]);
    expect(linesForStream(LOGS, 'rtt')).toEqual([]);
  });
});

describe('StepLogTabs', () => {
  it('renders all five §5.2 stream tabs with the agent tab selected', () => {
    render(<StepLogTabs stepTitle="Flash firmware" logs={LOGS} />);
    const tablist = screen.getByRole('tablist', { name: 'Flash firmware log streams' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Agent2',
      'Build',
      'Flash1',
      'Serial1',
      'RTT',
    ]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');

    const pane = screen.getByRole('log', { name: 'Flash firmware — Agent log' });
    expect(pane).toHaveTextContent('Flashing firmware via pyOCD…');
    expect(pane).toHaveTextContent('Flash complete, resetting target.');
    expect(pane).not.toHaveTextContent('[pyocd] erased 2 sectors');
  });

  it('switches panes per stream, and an empty stream shows the empty state', async () => {
    const user = userEvent.setup();
    render(<StepLogTabs stepTitle="Flash firmware" logs={LOGS} />);

    await user.click(screen.getByRole('tab', { name: /Serial/ }));
    const serialPane = screen.getByRole('log', { name: 'Flash firmware — Serial log' });
    expect(serialPane).toHaveTextContent('TEMP=24.3 HUM=41.2');
    expect(serialPane).not.toHaveTextContent('Flashing firmware via pyOCD…');

    await user.click(screen.getByRole('tab', { name: 'RTT' }));
    expect(screen.getByText('No output yet.')).toBeInTheDocument();
  });
});
