// The §7.4 bar for the T3.2 tabs, end to end against a live mock runner: from
// the workspace, the failed serial_output chip reaches iteration 1's serial log
// (Logs tab, exact sub-tab), Open Diff reaches the rendered code diff with the
// per-file reason and a live rollback affordance, and a check row's "view
// evidence" reaches its raw artifact with a correct download filename — every
// verdict traceable to its artifact in ≤2 clicks. Real HTTP + WebSocket +
// artifact fetch + Zod parse; only the runner URL is stubbed.
//
// Everything that reads lib/config (App → api singleton) is imported dynamically
// AFTER the runner is up and VITE_RUNNER_URL is stubbed, so the api the tabs
// fetch with binds to the ephemeral port.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import { reduceRun, type RunView } from '@boardex/contract';
import type { ComponentType } from 'react';
import type { ApiClient } from '../../lib/api';

let runner: MockRunner;
let App: ComponentType;
let client: ApiClient;
let runId: string;
const hadWebSocket = 'WebSocket' in globalThis;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function currentView(id: string): Promise<RunView | null> {
  const events = await client.getRunEvents(id);
  return events.length === 0 ? null : reduceRun(events);
}

async function waitForView(
  id: string,
  pred: (view: RunView) => boolean,
  timeoutMs = 30000,
): Promise<RunView> {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    const view = await currentView(id);
    if (view && pred(view)) return view;
    await sleep(50);
  }
  throw new Error('timeout waiting for run state');
}

// Drive one run to the fix-approval gate (plan approved, flash approved,
// iteration 1 evaluated, diagnosis posted, replay paused) — a stable mid-run
// point shared by every test below; the run is non-terminal there.
beforeAll(async () => {
  runner = await createMockRunner({ port: 0, speed: 200 });
  vi.stubEnv('VITE_RUNNER_URL', runner.url);
  (globalThis as Record<string, unknown>).WebSocket = WebSocket;
  App = (await import('../../App')).default;
  client = (await import('../../lib/api')).createApiClient(runner.url);

  const created = await client.createRun({
    taskPrompt: 'Bring up the BME280 sensor over I2C.',
    boardProfileId: 'bp_nucleo_f303re',
  });
  runId = created.runId;
  await waitForView(runId, (view) => view.run.status === 'plan_ready');
  await client.approvePlan(runId);
  const atFlashGate = await waitForView(runId, (view) =>
    view.approvals.some((approval) => approval.status === 'pending'),
  );
  const flashApproval = atFlashGate.approvals.find((approval) => approval.status === 'pending')!;
  await client.resolveApproval(runId, flashApproval.id, 'approved');
  await waitForView(
    runId,
    (view) =>
      view.checks.some(
        (check) => check.requirementId === 'serial_output' && check.verdict === 'fail',
      ) && view.approvals.some((approval) => approval.status === 'pending'),
  );
}, 60000);

// jsdom reports zero offset sizes, so the LogViewer's virtualizer would render
// no rows at all — give every element a box (same treatment as LogViewer.test).
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 640,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 320,
  });
});

afterAll(async () => {
  await runner.close();
  vi.unstubAllEnvs();
  if (!hadWebSocket) delete (globalThis as Record<string, unknown>).WebSocket;
});

function renderApp(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('§7.4 acceptance: T3.2 tabs against the live mock', () => {
  it('reaches iteration 1’s serial log in ONE click from the failed serial_output chip', async () => {
    const user = userEvent.setup();
    const { unmount } = renderApp(`/runs/${runId}`);

    const chip = await screen.findByRole('link', { name: /Serial output/ }, { timeout: 20000 });
    expect(chip.getAttribute('href')).toBe(
      `/runs/${runId}/evidence?artifact=art_serial_log_iter1`,
    );

    await user.click(chip);
    const dialog = await screen.findByRole('dialog', { name: 'Evidence' });
    expect(within(dialog).getByRole('tab', { name: 'Logs' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Sub-tabs labeled by kind + iteration; the deep link selected the serial one.
    const logTabs = within(dialog).getByRole('tablist', { name: 'Log artifacts' });
    expect(within(logTabs).getByRole('tab', { name: 'Serial — iteration 1' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const log = await within(dialog).findByRole(
      'log',
      { name: 'Serial log (iteration 1)' },
      { timeout: 15000 },
    );
    await waitFor(() => {
      expect(log).toHaveTextContent('BME280 FATAL: sensor not responding, heartbeat only');
    });
    unmount();
  }, 90000);

  it('reaches the rendered code diff via Open Diff, rollback enabled while non-terminal', async () => {
    const user = userEvent.setup();
    const { unmount } = renderApp(`/runs/${runId}`);

    const openDiff = await screen.findByRole('link', { name: 'Open Diff' }, { timeout: 20000 });
    expect(openDiff.getAttribute('href')).toBe(
      `/runs/${runId}/evidence?artifact=art_diff_iter1`,
    );

    await user.click(openDiff);
    const dialog = await screen.findByRole('dialog', { name: 'Evidence' });
    expect(within(dialog).getByRole('tab', { name: 'Code Diff' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Per-file path + reason line, and real parsed hunks from the fixture diff.
    expect(await within(dialog).findByText('main.c', undefined, { timeout: 15000 }))
      .toBeInTheDocument();
    expect(within(dialog).getByText(/Add a register-level I2C1 driver/)).toBeInTheDocument();
    const table = within(dialog).getByRole('table', { name: 'Unified diff for main.c' });
    expect(table.querySelectorAll('tr[data-diff="add"]').length).toBeGreaterThan(10);

    const rollback = within(dialog).getByRole('button', { name: 'Rollback' });
    expect(rollback).toBeEnabled();
    unmount();
  }, 90000);

  it('reaches the timing artifact from the i2c_clock check row in two clicks, downloadable', async () => {
    const user = userEvent.setup();
    // Click 1 (conceptually): opening the evidence surface — default Checks tab.
    const { unmount } = renderApp(`/runs/${runId}/evidence`);

    const dialog = await screen.findByRole('dialog', { name: 'Evidence' }, { timeout: 20000 });
    const checksTable = await within(dialog).findByRole(
      'table',
      { name: 'Measurement checks' },
      { timeout: 20000 },
    );
    const clockRow = within(checksTable)
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('i2c_clock'));
    expect(clockRow).toBeDefined();

    // Click 2: the check's own "view evidence" link → Raw artifacts, highlighted.
    await user.click(within(clockRow!).getByRole('link', { name: 'View evidence' }));
    expect(within(dialog).getByRole('tab', { name: 'Raw artifacts' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const rawTable = within(dialog).getByRole('table', { name: 'Raw artifacts' });
    const highlighted = rawTable.querySelectorAll('tbody tr[data-highlighted]');
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toHaveTextContent('SCL frequency measurement (iteration 1)');
    expect(highlighted[0]).toHaveTextContent('timing_measurement');
    expect(highlighted[0]).toHaveTextContent('76 B');
    // Download carries the kind-derived filename (§7.4: right filename).
    expect(
      within(highlighted[0] as HTMLElement).getByRole('button', { name: 'Download' }),
    ).toHaveAttribute('title', 'Download art_scl_timing_iter1.json');
    unmount();
  }, 90000);
});
