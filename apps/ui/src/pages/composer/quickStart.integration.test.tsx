// Quick Start end to end against a live mock runner (BIBLE §7.2, v0): "+ New board" →
// a real repo path in this very repository → POST /workspace/validate over real HTTP →
// Create Run Plan compiles the profile, POSTs it to /board-profiles, creates the run
// against it → the plan gate renders THAT profile's D12 checklist and stays shut until
// every line is confirmed by hand.
//
// Real HTTP + WebSocket, real filesystem (examples/firmware/blinky-f303re carries a
// Makefile); only the runner URL is stubbed. Everything reading lib/config is imported
// dynamically after VITE_RUNNER_URL is set, as in composer.integration.test.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import type { ComponentType } from 'react';

let runner: MockRunner;
let App: ComponentType;
const hadWebSocket = 'WebSocket' in globalThis;

// A real firmware folder in this repo — the probe reads the runner's filesystem, and
// in-process that is ours. cwd is apps/ui when vitest runs.
const FIRMWARE_PATH = resolve(process.cwd(), '../../examples/firmware/blinky-f303re');

beforeAll(async () => {
  runner = await createMockRunner({ port: 0, speed: 200 });
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

describe('Quick Start → compiled profile → plan gate (integration)', () => {
  it('creates a board and a run from a path and a prompt, and still gates on D12', async () => {
    const user = userEvent.setup();
    renderApp();

    const textarea = await screen.findByRole('textbox', { name: 'Ask Boardex' });
    await screen.findByRole('option', { name: 'Nucleo-F303RE' }, { timeout: 10000 });

    await user.click(screen.getByRole('button', { name: '+ New board' }));
    const panel = screen.getByRole('region', { name: 'Quick Start' });

    // The path validates on blur against the runner's own filesystem.
    await user.click(within(panel).getByLabelText('Repo path'));
    await user.paste(FIRMWARE_PATH);
    await user.tab();
    expect(
      await screen.findByText(/Firmware folder found on the runner/, undefined, { timeout: 10000 }),
    ).toBeInTheDocument();
    expect(within(panel).getByText('make')).toBeInTheDocument();
    // The board name came from the folder.
    expect(within(panel).getByLabelText('Board name')).toHaveValue('blinky-f303re');

    await user.click(textarea);
    await user.paste('Bring up the BME280 sensor over I2C and verify readings.');
    await user.click(screen.getByRole('button', { name: 'Create Run Plan' }));

    // POST /board-profiles then POST /runs against the profile it just saved: the
    // runner now serves a second profile, and the run resolves to it.
    const approve = await screen.findByRole(
      'button',
      { name: /approve plan/i },
      { timeout: 20000 },
    );
    const profiles = await (await fetch(`${runner.url}/board-profiles`)).json();
    const compiled = (profiles as { id: string; name: string; buildCommand: string }[]).find(
      (p) => p.name === 'blinky-f303re',
    );
    expect(compiled).toMatchObject({ buildCommand: 'make' });

    // D12 UNCHANGED on a compiled profile: the three seeded preconditions render
    // unchecked, and Approve Plan opens only after a human confirms each one.
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    expect(screen.getByText('Board powered (3V3/5V confirmed)')).toBeInTheDocument();
    expect(screen.getByText('Debug probe connected')).toBeInTheDocument();
    expect(screen.getByText('Serial cable connected')).toBeInTheDocument();
    expect(approve).toBeDisabled();
    for (const box of boxes) {
      expect(box).not.toBeChecked();
      await user.click(box);
    }
    expect(approve).toBeEnabled();

    // …and the approved run proceeds into the workspace exactly as any other.
    await user.click(approve);
    await waitFor(
      () => expect(screen.getByRole('list', { name: 'Run timeline' })).toBeInTheDocument(),
      { timeout: 20000 },
    );
  }, 60000);
});
