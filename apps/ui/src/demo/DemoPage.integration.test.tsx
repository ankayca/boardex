// Demo shell integration (T6.5): the demo mounts the REAL workspace surfaces, plays
// to completion, and deep-links evidence within /demo — no runner, no api command.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
