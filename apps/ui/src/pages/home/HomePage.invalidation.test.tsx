import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { BoardProfile, Event, HealthResponse, Run, RunSummary } from '@boardex/contract';

// HomePage's contract with the global stream: run lifecycle events invalidate the
// authoritative ['runs'] query (GET /runs is the source of truth, §7.1); nothing else
// does. We mock the stream to capture HomePage's handler and drive it directly.
const getHealth = vi.fn<() => Promise<HealthResponse>>();
const listRuns = vi.fn<() => Promise<RunSummary[]>>();
const listBoardProfiles = vi.fn<() => Promise<BoardProfile[]>>();

vi.mock('../../lib/api', () => ({
  api: {
    getHealth: () => getHealth(),
    listRuns: () => listRuns(),
    listBoardProfiles: () => listBoardProfiles(),
    // HomePage reads the bench snapshot for its advisory indicator; this test is about
    // the ['runs'] invalidation, so the bench never resolves and the line never shows.
    getBench: () => new Promise(() => undefined),
  },
}));

let capturedHandler: ((event: Event) => void) | null = null;
vi.mock('../../lib/globalStream', () => ({
  useGlobalEvents: (handler: (event: Event) => void) => {
    capturedHandler = handler;
  },
  // useBenchStatus watches the socket's status to know when its snapshot went stale.
  subscribeGlobalStatus: () => () => undefined,
}));

import HomePage from './HomePage';

const online: HealthResponse = {
  ok: true,
  contractVersion: 'boardex-contract/0.1',
  runnerKind: 'mock',
};
const ts = '2026-07-07T14:00:00.000Z';

const run: Run = {
  id: 'r1',
  title: 'BME280 bring-up',
  taskPrompt: 'bring up',
  boardProfileId: 'bp_nucleo_f303re',
  status: 'planning',
  createdAt: ts,
  updatedAt: ts,
  iteration: 1,
};
const runCreated: Event = { seq: 1, runId: 'r1', ts, type: 'run.created', payload: { run } };
const statusChanged: Event = {
  seq: 2,
  runId: 'r1',
  ts,
  type: 'run.status_changed',
  payload: { status: 'running' },
};
const unrelated: Event = {
  seq: 3,
  runId: 'r1',
  ts,
  type: 'step.log',
  payload: { stepId: 's1', stream: 'build', line: 'compiling…' },
};

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

afterEach(() => {
  vi.clearAllMocks();
  capturedHandler = null;
});

describe('HomePage global-stream invalidation (BIBLE §7.1)', () => {
  it('invalidates the runs query on run.created and run.status_changed, and ignores other events', async () => {
    getHealth.mockResolvedValue(online);
    listRuns.mockResolvedValue([]);
    listBoardProfiles.mockResolvedValue([]);

    const { invalidateSpy } = renderHome();
    // Let the initial queries settle so any startup work is behind us.
    await screen.findByText('No runs yet');
    expect(capturedHandler).toBeTypeOf('function');
    invalidateSpy.mockClear();

    await act(async () => {
      capturedHandler?.(runCreated);
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['runs'] });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      capturedHandler?.(statusChanged);
    });
    expect(invalidateSpy).toHaveBeenLastCalledWith({ queryKey: ['runs'] });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);

    // An unrelated event must not touch the runs query.
    await act(async () => {
      capturedHandler?.(unrelated);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });
});
