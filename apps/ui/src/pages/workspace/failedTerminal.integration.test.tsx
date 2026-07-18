// The failed-terminal workspace against a live --fail-variant mock runner
// (T5.0/F9+F10): the fix lands, iteration 2's checks fail again, the run ends in
// run.failed with no further fix approval — and the workspace renders §7.3's
// terminal state: muted summary (Failed badge, frozen elapsed, no Stop Run) with
// the evidence retained (all three check chips, pass/fail/fail). This is also the
// failed leg of T5.2's cold-load matrix: the run is driven to terminal over pure
// HTTP and opened cold, so the workspace must come entirely from event replay —
// no run-socket construction, no reconnecting bar, duration frozen at endedAt.
//
// Everything that reads lib/config is imported dynamically AFTER the runner is up
// and VITE_RUNNER_URL is stubbed, so the api singleton binds to the ephemeral port.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import { reduceRun } from '@boardex/contract';
import type { ComponentType } from 'react';
import type { ApiClient } from '../../lib/api';
import { elapsedLabel } from './elapsed';

let runner: MockRunner;
let App: ComponentType;
let api: ApiClient;
const hadWebSocket = 'WebSocket' in globalThis;

// Every socket the app opens, by URL (T5.2): a terminal cold-load must never
// construct a run socket (`?runId=`); the global dashboard stream is legitimate.
const socketUrls: string[] = [];
class RecordingWebSocket extends WebSocket {
  constructor(url: string) {
    socketUrls.push(String(url));
    super(url);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  runner = await createMockRunner({ port: 0, speed: 200, failVariant: true });
  vi.stubEnv('VITE_RUNNER_URL', runner.url);
  (globalThis as Record<string, unknown>).WebSocket = RecordingWebSocket;
  App = (await import('../../App')).default;
  api = (await import('../../lib/api')).api;
});

afterAll(async () => {
  await runner.close();
  vi.unstubAllEnvs();
  if (!hadWebSocket) delete (globalThis as Record<string, unknown>).WebSocket;
});

// Drive the run over HTTP to its terminal state: approve the plan and every
// pending approval as it appears. The UI under test is the terminal WORKSPACE;
// the gate-driving UI has its own integration tests.
async function driveToTerminal(runId: string): Promise<void> {
  const resolved = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const events = await api.getRunEvents(runId);
    if (events.length > 0) {
      const view = reduceRun(events)!;
      if (['completed', 'failed', 'stopped'].includes(view.run.status)) return;
      if (view.run.status === 'plan_ready' && !resolved.has('__plan__')) {
        resolved.add('__plan__');
        await api.approvePlan(runId);
      }
      const pending = view.approvals.find((a) => a.status === 'pending');
      if (pending && !resolved.has(pending.id)) {
        resolved.add(pending.id);
        await api.resolveApproval(runId, pending.id, 'approved');
      }
    }
    await sleep(10);
  }
  throw new Error('run did not reach a terminal state in time');
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

describe('failed-terminal workspace (--fail-variant, integration)', () => {
  it('renders the failed run with its evidence retained and no Stop Run', async () => {
    const { runId } = await api.createRun({
      taskPrompt: 'bring up BME280',
      boardProfileId: 'bp_nucleo_f303re',
    });
    await driveToTerminal(runId);
    const view = reduceRun(await api.getRunEvents(runId))!;

    socketUrls.length = 0;
    renderWorkspace(runId);

    // Terminal status: the Failed badge in the status card, frozen elapsed, and —
    // §7.3 — no Stop Run once terminal.
    const statusCard = await screen.findByRole(
      'region',
      { name: 'Run status' },
      { timeout: 20000 },
    );
    expect(within(statusCard).getByText('Failed')).toBeInTheDocument();
    expect(within(statusCard).getByText(/Elapsed/)).toBeInTheDocument();
    // Frozen duration (§5.4 v1.5): exactly createdAt → endedAt, no wall clock.
    const frozen = elapsedLabel(view.run.createdAt, Date.parse(view.endedAt!))!;
    expect(within(statusCard).getByText(frozen)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stop run/i })).not.toBeInTheDocument();

    // A conforming stream produced zero contract warnings.
    expect(screen.queryByText(/contract warning/)).not.toBeInTheDocument();

    // Evidence retained: all three checks chip the band — pass, fail, fail.
    const band = await screen.findByRole('region', { name: 'Evidence summary' });
    const chips = within(band).getAllByRole('listitem');
    expect(chips).toHaveLength(3);
    const badgeTexts = chips.flatMap((chip) =>
      ['Pass', 'Fail'].filter((label) => within(chip).queryByText(label) !== null),
    );
    expect(badgeTexts.filter((label) => label === 'Fail')).toHaveLength(2);
    expect(badgeTexts.filter((label) => label === 'Pass')).toHaveLength(1);

    // The timeline (the run's history) is still on screen, not blanked.
    expect(screen.getByRole('list', { name: 'Run timeline' })).toBeInTheDocument();

    // The fail variant produces no report_md: Open Report degrades to an inert
    // action, never a dead link.
    expect(screen.queryByRole('link', { name: 'Open Report' })).not.toBeInTheDocument();
    expect(within(band).getByText('Open Report')).toBeInTheDocument();

    // T5.2: everything above rendered from HTTP replay alone — no run socket was
    // attempted (D5; a runner refusing sockets for archived runs works perfectly),
    // and a terminal load never shows the reconnecting bar.
    expect(socketUrls.filter((url) => url.includes('runId='))).toEqual([]);
    expect(screen.queryByText(/Reconnecting to the runner/)).not.toBeInTheDocument();
  }, 60000);
});
