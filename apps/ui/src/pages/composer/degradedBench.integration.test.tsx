// Degraded-bench composer flow against a live mock runner started with --degraded
// (BIBLE §7.2, state "degraded bench"). Three properties, end to end:
//
//   1. the inline warning names the affected device with its state-specific copy —
//      "on the bench but offline", never "not found on the bench";
//   2. the warning repeats inside the plan-approval section;
//   3. it is advisory, not blocking — composing and approving both stay allowed.
//
// Real HTTP + WebSocket; only the runner URL is stubbed. Everything that reads
// lib/config (App → pages → api) is imported dynamically AFTER the runner is up and
// VITE_RUNNER_URL is stubbed, so the api singleton binds to the ephemeral port.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import type { ComponentType } from 'react';

// --degraded marks the canned profile's logic analyzer offline. The profile references
// it by its stable device id, so it MATCHES and is degraded — not missing.
const DEGRADED_LINE = 'Kingst LA2016 is on the bench but offline (Not detected by sigrok)';

let runner: MockRunner;
let App: ComponentType;
const hadWebSocket = 'WebSocket' in globalThis;

beforeAll(async () => {
  runner = await createMockRunner({ port: 0, speed: 200, degraded: true });
  vi.stubEnv('VITE_RUNNER_URL', runner.url);
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

describe('degraded bench → compose → approve (integration, --degraded)', () => {
  it('warns, repeats the warning at approval, and blocks neither', async () => {
    const user = userEvent.setup();
    renderApp();

    const textarea = await screen.findByRole('textbox', { name: 'Ask Boardex' });
    await screen.findByRole('option', { name: 'Nucleo-F303RE' }, { timeout: 10000 });

    // (1) The inline warning names the offline device with the degraded sentence.
    await screen.findByRole('list', { name: 'Bench readiness' }, { timeout: 10000 });
    expect(await screen.findByText('Bench degraded', undefined, { timeout: 10000 })).toBeInTheDocument();
    expect(screen.getByText(DEGRADED_LINE)).toBeInTheDocument();
    // The profile's references both resolve, so nothing reads as unknown.
    expect(screen.queryByText(/was not found on the bench/)).not.toBeInTheDocument();

    // (3a) Composing stays allowed.
    await user.click(textarea);
    await user.paste('Bring up the BME280 sensor over I2C and verify readings.');
    const create = screen.getByRole('button', { name: 'Create Run Plan' });
    expect(create).toBeEnabled();
    await user.click(create);

    // (2) The warning repeats inside the plan-approval section, adjacent to the D12 gate.
    const approve = await screen.findByRole('button', { name: 'Approve Plan' }, { timeout: 20000 });
    const planSection = screen.getByRole('region', { name: 'Run plan' });
    expect(within(planSection).getByText('Bench degraded')).toBeInTheDocument();
    expect(within(planSection).getByText(DEGRADED_LINE)).toBeInTheDocument();

    // (3b) The degraded bench does not gate approval — only the checklist does, and it
    // is satisfiable. Approve lands the run in the workspace.
    expect(approve).toBeDisabled();
    for (const box of within(planSection).getAllByRole('checkbox')) {
      await user.click(box);
    }
    expect(approve).toBeEnabled();

    await user.click(approve);
    await waitFor(
      () => expect(screen.getByRole('list', { name: 'Run timeline' })).toBeInTheDocument(),
      { timeout: 20000 },
    );
  }, 60000);
});
