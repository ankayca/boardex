// Demo shell integration (T6.5): the demo mounts the REAL workspace surfaces, plays
// to completion, and deep-links evidence within /demo — no runner, no api command.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DemoPage from './DemoPage';
import { resetTourMemory } from './Tour';

function renderDemo() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/demo']}>
        <Routes>
          <Route path="/" element={<h1>Runs home</h1>} />
          <Route path="/demo/*" element={<DemoPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => resetTourMemory());
afterEach(() => resetTourMemory());

describe('DemoPage', () => {
  it('replays to completion through the real workspace, with evidence deep-linking into /demo', async () => {
    const user = userEvent.setup();
    renderDemo();

    // The read-only demo shell frame.
    expect(await screen.findByText('replaying a recorded agent run')).toBeInTheDocument();

    // Skip to the end: the reused Status & Approval rail and evidence band render.
    await user.click(screen.getByRole('button', { name: 'Skip to end' }));

    expect(await screen.findByText('Demo complete')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Run status' })).toBeInTheDocument();

    // Evidence band chips landed, and they deep-link within the demo (not /runs/...).
    const checks = await screen.findByRole('list', { name: 'Evidence checks' });
    const firstChip = within(checks).getAllByRole('link')[0]!;
    expect(firstChip.getAttribute('href')).toMatch(/^\/demo\/evidence\?artifact=/);

    // The report — the deliverable — links to the demo report screen.
    expect(screen.getByRole('link', { name: 'Open Report' })).toHaveAttribute(
      'href',
      '/demo/report',
    );

    // The guided tour is present and, at the end, on its final (report) moment.
    expect(screen.getByRole('region', { name: 'Demo tour' })).toBeInTheDocument();
    expect(screen.getByText('The deliverable')).toBeInTheDocument();

    // Opening the report renders the bundled report_md through the api demo-source
    // branch — offline, no runner.
    await user.click(screen.getByRole('link', { name: 'Open Report' }));
    expect(
      await screen.findByText(/Validation Report — BME280 bring-up on Nucleo-F303RE/),
    ).toBeInTheDocument();
  });

  it('opens evidence within the demo and serves the bundled artifact offline', async () => {
    const user = userEvent.setup();
    renderDemo();
    await screen.findByText('replaying a recorded agent run');
    await user.click(screen.getByRole('button', { name: 'Skip to end' }));

    // Open Logs deep-links the evidence drawer at the run's serial log artifact. The
    // drawer opens within the demo and the demo-source branch serves the artifact — the
    // fail-closed fetch-error notice never appears (the LogViewer itself is virtualized,
    // so its rows aren't asserted here; the report test covers rendered content).
    await user.click(await screen.findByRole('link', { name: 'Open Logs' }));
    const logsTab = await screen.findByRole('tab', { name: 'Logs' });
    await waitFor(() => expect(logsTab).toHaveAttribute('aria-selected', 'true'));
    expect(screen.queryByText(/could.{0,3}t load/i)).not.toBeInTheDocument();
  });

  it('exits the demo to the runs home — issuing no runner command', async () => {
    const user = userEvent.setup();
    renderDemo();
    await screen.findByText('replaying a recorded agent run');

    await user.click(screen.getByRole('button', { name: 'Exit demo' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Runs home' })).toBeInTheDocument());
  });
});

// The demo gate can't keep the live rail's promises (F1/P5): its Stop merely leaves the
// replay, and Reject has no rejected ending to play (the recording was approved). These
// drive the REAL rail through the paced playback, one recorded event per tick, and stop
// at the gate — no fabricated events, no live confirm copy.
describe('DemoPage — demo-gate command safety', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-07-14T16:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Each recorded gap is ≤ the pace cap, and the next timer is only scheduled after the
  // prior event's state commits — so one 2600ms tick ingests exactly one event.
  function advanceUntil(present: () => boolean, maxEvents = 40): void {
    for (let i = 0; i < maxEvents && !present(); i++) {
      act(() => {
        vi.advanceTimersByTime(2600);
      });
    }
  }

  // The mutate() path (react-query) invokes the command in a microtask; flush it so the
  // exit/notice lands before we assert.
  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('Stop Run exits the demo directly, with no confirm dialog (P5)', async () => {
    renderDemo();
    advanceUntil(() => screen.queryByRole('button', { name: 'Stop Run' }) !== null);

    fireEvent.click(screen.getByRole('button', { name: 'Stop Run' }));
    await flush();

    // No ConfirmDialog — the live "ends immediately as Stopped … Evidence retained"
    // copy would promise what the demo can't keep — and it leaves straight away.
    expect(screen.queryByRole('dialog', { name: 'Stop this run?' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Runs home' })).toBeInTheDocument();
  });

  it('Reject at the gate surfaces the honest notice and exits — no playback continuation (F1)', async () => {
    renderDemo();
    advanceUntil(() => screen.queryByRole('button', { name: 'Reject' }) !== null);
    // We stopped AT the gate: the recorded resolution has not played.
    expect(screen.queryByText('Demo complete')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await flush();

    const notice = screen.getByRole('dialog', { name: 'Reject ends the run' });
    expect(within(notice).getByText(/This recording was approved/)).toBeInTheDocument();
    // Playback did not fast-forward into a fabricated ending: still in the demo, not
    // completed, until the user chooses to leave.
    expect(screen.queryByRole('heading', { name: 'Runs home' })).toBeNull();
    expect(screen.queryByText('Demo complete')).toBeNull();

    fireEvent.click(within(notice).getByRole('button', { name: 'Exit demo' }));
    await flush();
    expect(screen.getByRole('heading', { name: 'Runs home' })).toBeInTheDocument();
  });
});
