// Full composer flow against a live mock runner (BIBLE §7.2 / T1.3 acceptance):
// compose a task → Create Run Plan (POST /runs) → land on /runs/:id in composer mode
// → the plan renders in place when run.plan_generated arrives → confirm every D12
// checklist line → Approve Plan (POST plan/approve) → the run resumes and the page
// hands over to the workspace. Real HTTP + WebSocket end to end; only the runner URL
// is stubbed.
//
// Everything that reads lib/config (App → pages → api) is imported dynamically AFTER
// the runner is up and VITE_RUNNER_URL is stubbed, so the api singleton binds to the
// ephemeral port.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import type { ComponentType } from 'react';

let runner: MockRunner;
let App: ComponentType;
const hadWebSocket = 'WebSocket' in globalThis;

beforeAll(async () => {
  // SPEED=200 compresses the fixture's bench-realistic delays to milliseconds.
  runner = await createMockRunner({ port: 0, speed: 200 });
  vi.stubEnv('VITE_RUNNER_URL', runner.url);
  // jsdom ships no WebSocket; the ws package satisfies the client's structural type.
  (globalThis as Record<string, unknown>).WebSocket = WebSocket;
  App = (await import('../../App')).default;
});

afterAll(async () => {
  await runner.close();
  vi.unstubAllEnvs();
  if (!hadWebSocket) delete (globalThis as Record<string, unknown>).WebSocket;
});

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs/new']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('composer → plan → approve (integration)', () => {
  it('drives the full flow against the mock runner', async () => {
    const user = userEvent.setup();
    renderApp();

    // Draft state: hero textarea + canned profile loaded from GET /board-profiles.
    const textarea = await screen.findByRole('textbox', { name: 'Ask Boardex' });
    await screen.findByRole('option', { name: 'Nucleo-F303RE' }, { timeout: 10000 });

    await user.click(textarea);
    await user.paste('Bring up the BME280 sensor over I2C and verify readings.');

    // Bench readiness renders inline from runner.status / GET /bench.
    await screen.findByRole('list', { name: 'Bench readiness' }, { timeout: 10000 });
    expect(screen.queryByText('Bench degraded')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create Run Plan' }));

    // POST /runs navigated to /runs/:id; the plan renders in place once
    // run.plan_generated arrives and the mock pauses at the plan gate.
    const approve = await screen.findByRole(
      'button',
      { name: 'Approve Plan' },
      { timeout: 20000 },
    );
    const planSteps = within(screen.getByRole('list', { name: 'Plan steps' })).getAllByRole(
      'listitem',
    );
    expect(planSteps).toHaveLength(6);
    expect(screen.getByText(/Risk summary:/)).toBeInTheDocument();

    // D12 gate: the canned profile ships a 6-line connection checklist; Approve stays
    // disabled until every line is confirmed.
    expect(approve).toBeDisabled();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(6);
    for (const box of boxes) {
      await user.click(box);
    }
    expect(approve).toBeEnabled();

    // Approve Plan → POST /runs/{id}/plan/approve → replay resumes, the status leaves
    // plan_ready, and composer mode hands over to the Run Workspace (T2.1): the
    // timeline renders in the center zone and the composer's approval surface is gone.
    await user.click(approve);
    await waitFor(
      () => expect(screen.getByRole('list', { name: 'Run timeline' })).toBeInTheDocument(),
      { timeout: 20000 },
    );
    expect(screen.getByRole('complementary', { name: 'Board context' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve Plan' })).not.toBeInTheDocument();
  }, 60000);
});
