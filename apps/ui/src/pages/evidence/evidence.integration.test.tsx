// The §7.4 bar, end to end against a live mock runner: from the fixture's failed
// device_ack check, a user reaches the exact NACK rows in ≤2 clicks. Real HTTP +
// WebSocket + artifact fetch + Zod parse; only the runner URL is stubbed. The run
// is driven to the fix-approval gate (iteration 1 evaluated, device_ack FAIL) via
// the command API, then the browser flow takes over.
//
// Everything that reads lib/config (App → api singleton) is imported dynamically
// AFTER the runner is up and VITE_RUNNER_URL is stubbed, so the api the DecodeTab
// fetches with binds to the ephemeral port.
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
const hadWebSocket = 'WebSocket' in globalThis;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Drive-by-API view of the run, via the same HTTP replay + reducer the UI uses.
// Null until run.created lands — the log can be empty right after POST /runs.
async function currentView(runId: string): Promise<RunView | null> {
  const events = await client.getRunEvents(runId);
  return events.length === 0 ? null : reduceRun(events);
}

async function waitForView(
  runId: string,
  pred: (view: RunView) => boolean,
  timeoutMs = 30000,
): Promise<RunView> {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    const view = await currentView(runId);
    if (view && pred(view)) return view;
    await sleep(50);
  }
  throw new Error('timeout waiting for run state');
}

beforeAll(async () => {
  runner = await createMockRunner({ port: 0, speed: 200 });
  vi.stubEnv('VITE_RUNNER_URL', runner.url);
  (globalThis as Record<string, unknown>).WebSocket = WebSocket;
  App = (await import('../../App')).default;
  client = (await import('../../lib/api')).createApiClient(runner.url);
});

afterAll(async () => {
  await runner.close();
  vi.unstubAllEnvs();
  if (!hadWebSocket) delete (globalThis as Record<string, unknown>).WebSocket;
});

// Create a run and drive it to the fix-approval gate: plan approved, flash
// approved, iteration 1 evaluated (device_ack FAIL), diagnosis posted, replay
// paused awaiting the fix approval — a stable mid-run point.
async function runToDiagnosisGate(): Promise<string> {
  const { runId } = await client.createRun({
    taskPrompt: 'Bring up the BME280 sensor over I2C.',
    boardProfileId: 'bp_nucleo_f303re',
  });
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
        (check) => check.requirementId === 'device_ack' && check.verdict === 'fail',
      ) && view.approvals.some((approval) => approval.status === 'pending'),
  );
  return runId;
}

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

// The exact NACK rows: iteration 1's decode has three transactions, every one an
// address NACK on 0x3B (0x76 written unshifted — the bug itself).
async function expectNackRows(scope: HTMLElement): Promise<void> {
  const table = await within(scope).findByRole(
    'table',
    { name: 'Decoded transactions' },
    { timeout: 15000 },
  );
  await waitFor(() => {
    const failed = table.querySelectorAll('tbody tr[data-failed]');
    expect(failed).toHaveLength(3);
  });
  const rows = table.querySelectorAll('tbody tr');
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row).toHaveClass('bg-fail-bg');
    expect(row).toHaveTextContent('0x3B');
    expect(row).toHaveTextContent('NACK (address)');
    expect(row).toHaveTextContent('ADDRESS WRITE: 76 NACK');
  }
}

describe('§7.4 acceptance: failed device_ack → exact NACK rows (integration)', () => {
  it('reaches the NACK rows in ONE click from the workspace evidence band', async () => {
    const runId = await runToDiagnosisGate();
    const user = userEvent.setup();
    renderApp(`/runs/${runId}`);

    // The workspace at the fix gate: the device_ack chip carries the FAIL badge and
    // deep-links iteration 1's protocol decode.
    const chip = await screen.findByRole('link', { name: /Device ack/ }, { timeout: 20000 });
    expect(chip.getAttribute('href')).toBe(`/runs/${runId}/evidence?artifact=art_i2c_decode_iter1`);

    // The Diagnosis Card's existing link targets the same evidence, unmodified.
    const diagnosis = await screen.findByRole('region', { name: 'Diagnosis' }, { timeout: 20000 });
    const diagnosisLink = within(diagnosis).getAllByRole('link', { name: 'View evidence' })[0];
    expect(diagnosisLink?.getAttribute('href')).toBe(
      `/runs/${runId}/evidence?artifact=art_i2c_decode_iter1`,
    );

    // Click 1: the chip. Drawer opens on the Protocol Decode tab, scrolled to the
    // failure — the exact NACK rows, tinted with the fail bg tint.
    await user.click(chip);
    const dialog = await screen.findByRole('dialog', { name: 'Evidence' });
    expect(within(dialog).getByRole('tab', { name: 'Protocol Decode' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectNackRows(dialog);
  }, 90000);

  it('reaches the NACK rows in two clicks through the Checks tab (check-row link)', async () => {
    const runId = await runToDiagnosisGate();
    const user = userEvent.setup();
    // Click 1 (conceptually): opening the evidence surface — land on the default
    // Checks tab with no artifact targeted.
    renderApp(`/runs/${runId}/evidence`);

    const dialog = await screen.findByRole('dialog', { name: 'Evidence' }, { timeout: 20000 });
    const checksTable = await within(dialog).findByRole(
      'table',
      { name: 'Measurement checks' },
      { timeout: 20000 },
    );
    const ackRow = within(checksTable)
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('device_ack'));
    expect(ackRow).toBeDefined();
    expect(ackRow!.querySelector('[data-kind="verdict"][data-value="fail"]')).not.toBeNull();

    // Click 2: the failed check's own "view evidence" link.
    await user.click(within(ackRow!).getByRole('link', { name: 'View evidence' }));
    expect(
      within(dialog).getByRole('tab', { name: 'Protocol Decode' }),
    ).toHaveAttribute('aria-selected', 'true');
    await expectNackRows(dialog);
  }, 90000);
});
