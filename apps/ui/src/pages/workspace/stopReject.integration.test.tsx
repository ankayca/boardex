// UI-driven terminal endings against a live mock runner (T5.0/F10): the two paths
// a human ends a run from the workspace itself.
//   1. Stop Run — ConfirmDialog → POST /runs/{id}/stop → run.stopped → the
//      stopped workspace (Stopped badge, Stop gone, evidence retained).
//   2. Reject at the flash gate — Approval Card's Reject → POST approvals/{aid}
//      rejected → the mock's alternate ending → the stopped workspace.
// Real HTTP + WebSocket end to end; only the runner URL is stubbed. Config readers
// are imported dynamically after VITE_RUNNER_URL points at the ephemeral port.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import { reduceRun } from '@boardex/contract';
import type { ComponentType } from 'react';
import type { ApiClient } from '../../lib/api';

let runner: MockRunner;
let App: ComponentType;
let api: ApiClient;
const hadWebSocket = 'WebSocket' in globalThis;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  runner = await createMockRunner({ port: 0, speed: 200 });
  vi.stubEnv('VITE_RUNNER_URL', runner.url);
  (globalThis as Record<string, unknown>).WebSocket = WebSocket;
  App = (await import('../../App')).default;
  api = (await import('../../lib/api')).api;
});

afterAll(async () => {
  await runner.close();
  vi.unstubAllEnvs();
  if (!hadWebSocket) delete (globalThis as Record<string, unknown>).WebSocket;
});

// Create a run and approve its plan over HTTP, leaving the replay running toward
// the flash-approval gate. The endings under test are then driven through the UI.
async function createRunPastPlan(): Promise<string> {
  const { runId } = await api.createRun({
    taskPrompt: 'bring up BME280',
    boardProfileId: 'bp_nucleo_f303re',
  });
  for (let i = 0; i < 2000; i++) {
    const events = await api.getRunEvents(runId);
    if (events.length > 0 && reduceRun(events).run.status === 'plan_ready') {
      await api.approvePlan(runId);
      return runId;
    }
    await sleep(10);
  }
  throw new Error('run never reached plan_ready');
}

function renderWorkspace(runId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${runId}`]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function findStatusCard() {
  return screen.findByRole('region', { name: 'Run status' }, { timeout: 20000 });
}

describe('UI-driven terminal endings (integration)', () => {
  it('Stop Run: ConfirmDialog → POST /stop → the stopped workspace', async () => {
    const user = userEvent.setup();
    const runId = await createRunPastPlan();
    renderWorkspace(runId);

    // The workspace is live and non-terminal: Stop Run is on the rail (§7.3).
    const stop = await screen.findByRole('button', { name: 'Stop Run' }, { timeout: 20000 });
    await user.click(stop);

    // Nothing is sent until the ConfirmDialog confirms.
    const dialog = await screen.findByRole('dialog', { name: 'Stop this run?' });
    await user.click(within(dialog).getByRole('button', { name: 'Stop Run' }));

    // run.stopped arrives over the live socket: Stopped badge, Stop Run gone.
    const statusCard = await findStatusCard();
    await waitFor(() => expect(within(statusCard).getByText('Stopped')).toBeInTheDocument(), {
      timeout: 20000,
    });
    expect(screen.queryByRole('button', { name: /stop run/i })).not.toBeInTheDocument();
    // Evidence and history are retained, not blanked (§7.3 terminal state).
    expect(screen.getByRole('list', { name: 'Run timeline' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Evidence summary' })).toBeInTheDocument();
  }, 60000);

  it('Reject at the flash gate: Approval Card → POST rejected → the stopped workspace', async () => {
    const user = userEvent.setup();
    const runId = await createRunPastPlan();
    renderWorkspace(runId);

    // The mock pauses at the flash approval; the Approval Card owns the gate.
    const reject = await screen.findByRole('button', { name: 'Reject' }, { timeout: 20000 });
    await user.click(reject);

    // approval.resolved(rejected) + the alternate run.stopped ending (§5.6).
    const statusCard = await findStatusCard();
    await waitFor(() => expect(within(statusCard).getByText('Stopped')).toBeInTheDocument(), {
      timeout: 20000,
    });
    // The gate is gone with the run: no approve surface remains.
    expect(screen.queryByRole('button', { name: /approve & continue/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stop run/i })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Run timeline' })).toBeInTheDocument();
  }, 60000);
});
