// Run history cold-loads (T5.2, BIBLE §7.1/§7.3/D5): a terminal run opened cold —
// straight to /runs/:id in a fresh session, exactly what Home's history rows do —
// renders the FULL workspace from GET /runs/{id}/events replay alone: timeline,
// evidence band, report action, frozen duration, no reconnecting bar, and, spied on
// the WebSocket constructor, no run-socket connection attempted at all (the global
// dashboard socket is a different, legitimate stream). Completed and stopped are
// driven here against the default fixture; the failed terminal lives with the
// fail-variant runner in failedTerminal.integration.test.tsx.
//
// Everything that reads lib/config is imported dynamically AFTER the runner is up
// and VITE_RUNNER_URL is stubbed, so the api singleton binds to the ephemeral port.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import { reduceRun, type RunView } from '@boardex/contract';
import type { ComponentType } from 'react';
import type { ApiClient } from '../../lib/api';
import { elapsedLabel } from './elapsed';

let runner: MockRunner;
let App: ComponentType;
let api: ApiClient;
const hadWebSocket = 'WebSocket' in globalThis;

// Every socket the app opens, by URL. Cold-loading a terminal run must never
// construct a run socket (`?runId=`); the global stream (`?global=1`) is expected.
const socketUrls: string[] = [];
class RecordingWebSocket extends WebSocket {
  constructor(url: string) {
    socketUrls.push(String(url));
    super(url);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  runner = await createMockRunner({ port: 0, speed: 200 });
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

// The terminal view as the contract sees it — reduced from the authoritative HTTP
// log, used both to steer the drive and to compute expected on-screen values.
async function replayView(runId: string): Promise<RunView | null> {
  return reduceRun(await api.getRunEvents(runId));
}

// Drive the run over HTTP (no store, no socket — the UI under test does the
// replaying) until the given terminal status. `steer` acts on each reduced view.
async function driveTo(
  runId: string,
  terminal: RunView['run']['status'],
  steer: (view: RunView, resolved: Set<string>) => Promise<void>,
): Promise<RunView> {
  const resolved = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const view = await replayView(runId);
    if (view) {
      if (view.run.status === terminal) return view;
      await steer(view, resolved);
    }
    await sleep(10);
  }
  throw new Error(`run did not reach ${terminal} in time`);
}

const approveEverything = async (view: RunView, resolved: Set<string>): Promise<void> => {
  if (view.run.status === 'plan_ready' && !resolved.has('__plan__')) {
    resolved.add('__plan__');
    await api.approvePlan(view.run.id);
  }
  const pending = view.approvals.find((a) => a.status === 'pending');
  if (pending && !resolved.has(pending.id)) {
    resolved.add(pending.id);
    await api.resolveApproval(view.run.id, pending.id, 'approved');
  }
};

function renderColdWorkspace(runId: string) {
  socketUrls.length = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${runId}`]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The assertions every terminal cold-load shares: full workspace, frozen duration,
// no reconnecting bar, no Stop Run, and no run-socket construction.
async function expectTerminalWorkspace(view: RunView, badgeLabel: string): Promise<void> {
  const statusCard = await screen.findByRole('region', { name: 'Run status' }, { timeout: 20000 });
  expect(within(statusCard).getByText(badgeLabel)).toBeInTheDocument();

  // Frozen duration (§5.4 v1.5): exactly createdAt → endedAt, no wall clock.
  const frozen = elapsedLabel(view.run.createdAt, Date.parse(view.endedAt!))!;
  expect(within(statusCard).getByText(frozen)).toBeInTheDocument();

  expect(screen.getByRole('list', { name: 'Run timeline' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Evidence summary' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /stop run/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/Reconnecting to the runner/)).not.toBeInTheDocument();

  // The event-sourcing bet (D5): the workspace above came from HTTP replay alone.
  // No run socket was even attempted; only the global dashboard stream may exist.
  expect(socketUrls.filter((url) => url.includes('runId='))).toEqual([]);
}

describe('run history cold-loads (T5.2, integration)', () => {
  it('renders a completed run fully from replay: report link live, three passing checks', async () => {
    const { runId } = await api.createRun({
      taskPrompt: 'bring up BME280',
      boardProfileId: 'bp_nucleo_f303re',
    });
    const view = await driveTo(runId, 'completed', approveEverything);

    renderColdWorkspace(runId);
    await expectTerminalWorkspace(view, 'Completed');

    // The deliverable is reachable: Open Report is a real link to the §7.6 screen.
    const report = screen.getByRole('link', { name: 'Open Report' });
    expect(report).toHaveAttribute('href', `/runs/${runId}/report`);

    // Evidence retained: all three checks passing.
    const band = screen.getByRole('region', { name: 'Evidence summary' });
    const chips = within(band).getAllByRole('listitem');
    expect(chips).toHaveLength(3);
    for (const chip of chips) expect(within(chip).getByText('Pass')).toBeInTheDocument();
  }, 60000);

  it('renders a stopped run fully from replay: evidence-so-far retained, report disabled', async () => {
    const { runId } = await api.createRun({
      taskPrompt: 'bring up BME280',
      boardProfileId: 'bp_nucleo_f303re',
    });
    // Stop at the flash-approval gate — the deterministic mid-run abort.
    const view = await driveTo(runId, 'stopped', async (current, resolved) => {
      if (current.run.status === 'plan_ready' && !resolved.has('__plan__')) {
        resolved.add('__plan__');
        await api.approvePlan(runId);
      }
      if (current.approvals.some((a) => a.status === 'pending') && !resolved.has('__stop__')) {
        resolved.add('__stop__');
        await api.stopRun(runId);
      }
    });

    renderColdWorkspace(runId);
    await expectTerminalWorkspace(view, 'Stopped');

    // Stopped before any check evaluated or report produced: the band renders the
    // v2.4 truth — every registered check is Not recorded (neutral, never red) —
    // and Open Report degrades to an inert action, never a dead link.
    const band = screen.getByRole('region', { name: 'Evidence summary' });
    expect(within(band).getAllByText('Not recorded').length).toBeGreaterThan(0);
    expect(within(band).queryByText('No checks evaluated yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Report' })).not.toBeInTheDocument();
    expect(within(band).getByText('Open Report')).toBeInTheDocument();
  }, 60000);

  it('fails closed on an unknown run id: honest not-found state, no amber bar, no run socket (T5.2/F2)', async () => {
    // The runner genuinely 404s this id — the deterministic answer the stream
    // client must not retry into a reconnecting loop.
    renderColdWorkspace('run_does_not_exist');

    expect(
      await screen.findByText('Run not found on the runner', {}, { timeout: 20000 }),
    ).toBeInTheDocument();
    const back = screen.getByRole('link', { name: 'Back to Runs' });
    expect(back).toHaveAttribute('href', '/');

    expect(screen.queryByText(/Reconnecting to the runner/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Connecting to run/)).not.toBeInTheDocument();
    expect(socketUrls.filter((url) => url.includes('runId='))).toEqual([]);
  }, 60000);
});
