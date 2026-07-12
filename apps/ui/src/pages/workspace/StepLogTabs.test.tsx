// Log-tab routing per stream (T2.1): every §5.2 stream gets a tab, and each tab's
// pane shows exactly the lines that arrived on that stream, in order.
import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StepLogLine } from '@boardex/contract';
import { formatLogTime, groupLogsByStream } from './logStreams';
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

const TS = '2026-07-07T14:03:22Z';
const LOGS: readonly StepLogLine[] = [
  { stream: 'agent', line: 'Flashing firmware via pyOCD…', ts: TS },
  { stream: 'flash', line: '[pyocd] erased 2 sectors', ts: TS },
  { stream: 'agent', line: 'Flash complete, resetting target.', ts: TS },
  { stream: 'serial', line: 'TEMP=24.3 HUM=41.2', ts: TS },
];

describe('groupLogsByStream', () => {
  it('routes each entry to its stream, preserving arrival order and ts', () => {
    const grouped = groupLogsByStream(LOGS);
    expect(grouped.get('agent')).toEqual([
      { stream: 'agent', line: 'Flashing firmware via pyOCD…', ts: TS },
      { stream: 'agent', line: 'Flash complete, resetting target.', ts: TS },
    ]);
    expect(grouped.get('flash')).toEqual([{ stream: 'flash', line: '[pyocd] erased 2 sectors', ts: TS }]);
    expect(grouped.get('serial')).toEqual([{ stream: 'serial', line: 'TEMP=24.3 HUM=41.2', ts: TS }]);
    expect(grouped.has('build')).toBe(false);
    expect(grouped.has('rtt')).toBe(false);
  });
});

describe('formatLogTime', () => {
  it('reads the HH:MM:SS token literally, across zone forms, with no re-interpretation', () => {
    expect(formatLogTime('2026-07-07T14:03:22.114Z')).toBe('14:03:22');
    expect(formatLogTime('2026-07-07T09:31:05-05:00')).toBe('09:31:05');
    expect(formatLogTime('2026-07-07T14:03:22')).toBe('14:03:22'); // naive (§4)
  });

  it('falls back to the raw string when there is no recognizable time', () => {
    expect(formatLogTime('2026-07-07')).toBe('2026-07-07');
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

  it('opens on the first stream that has lines when agent is silent', () => {
    render(
      <StepLogTabs
        stepTitle="Build firmware"
        logs={[
          { stream: 'build', line: 'CC main.o', ts: TS },
          { stream: 'build', line: 'LD firmware.elf', ts: TS },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: /Build/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('log', { name: 'Build firmware — Build log' })).toHaveTextContent(
      'CC main.o',
    );
  });

  it('falls back to the agent tab when no stream has output yet', () => {
    render(<StepLogTabs stepTitle="Understand context" logs={[]} />);
    expect(screen.getByRole('tab', { name: 'Agent' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('No output yet.')).toBeInTheDocument();
  });
});
