import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { BenchStatus, BoardProfile, HealthResponse, RunSummary } from '@boardex/contract';
import type { WsConnectionStatus } from '../../lib/ws';

// Mock the HTTP client: HomePage's job is to turn these responses into the right
// screen state (loading / empty / populated / offline), which is what we assert.
const getHealth = vi.fn<() => Promise<HealthResponse>>();
const listRuns = vi.fn<() => Promise<RunSummary[]>>();
const listBoardProfiles = vi.fn<() => Promise<BoardProfile[]>>();
const getBench = vi.fn<() => Promise<BenchStatus>>();

vi.mock('../../lib/api', () => ({
  api: {
    getHealth: () => getHealth(),
    listRuns: () => listRuns(),
    listBoardProfiles: () => listBoardProfiles(),
    getBench: () => getBench(),
  },
}));

// The global WS is the liveness signal behind the bench snapshot (F1). Drive its
// status by hand so a socket drop can be separated from a /health failure.
const statusListeners = new Set<(status: WsConnectionStatus) => void>();
vi.mock('../../lib/globalStream', () => ({
  useGlobalEvents: () => undefined,
  subscribeGlobal: () => () => undefined,
  subscribeGlobalStatus: (listener: (status: WsConnectionStatus) => void) => {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  },
  globalStatus: () => 'open' as WsConnectionStatus,
}));

function emitWsStatus(status: WsConnectionStatus) {
  act(() => {
    for (const listener of [...statusListeners]) listener(status);
  });
}

import { useBenchStore } from '../../lib/benchStore';
import HomePage from './HomePage';

const online: HealthResponse = { ok: true, contractVersion: 'boardex-contract/0.1', runnerKind: 'mock' };

function bench(...states: ('online' | 'offline' | 'error')[]): BenchStatus {
  return {
    runnerOnline: true,
    contractVersion: 'boardex-contract/0.1',
    devices: states.map((state, index) => ({
      id: `dev_${index}`,
      kind: 'logic_analyzer' as const,
      name: `Device ${index}`,
      state,
    })),
  };
}

function summary(over: Partial<RunSummary> & Pick<RunSummary, 'id' | 'status'>): RunSummary {
  return {
    title: `Run ${over.id}`,
    boardProfileId: 'bp_nucleo_f303re',
    updatedAt: '2026-07-07T12:00:00.000Z',
    ...over,
  };
}

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getHealth.mockResolvedValue(online);
  listBoardProfiles.mockResolvedValue([]);
  getBench.mockResolvedValue(bench('online'));
  statusListeners.clear();
  useBenchStore.setState({ bench: null, generation: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('HomePage (BIBLE §7.1)', () => {
  it('shows the first-use hero with both actions when there are no runs', async () => {
    listRuns.mockResolvedValue([]);
    renderHome();
    expect(await screen.findByText('Bring up your first board')).toBeInTheDocument();
    // T6.1b: the header New Run action moved to the shell's top bar (Shell.test),
    // so the page itself carries exactly the hero's button.
    expect(screen.getAllByRole('button', { name: 'New Run' })).toHaveLength(1);
    // T6.5: the hero's secondary action opens the offline-capable demo run.
    expect(screen.getByRole('button', { name: 'Watch a demo run' })).toBeInTheDocument();
    // P1 #1: the process line gives the hero's whitespace a product-specific purpose.
    expect(screen.getByText('Plan → Flash → Measure → Verify')).toBeInTheDocument();
  });

  it('orders needs-attention runs above active and terminal ones', async () => {
    listRuns.mockResolvedValue([
      summary({ id: 'done', status: 'completed', updatedAt: '2026-07-07T13:00:00.000Z' }),
      summary({ id: 'busy', status: 'running', updatedAt: '2026-07-07T12:30:00.000Z' }),
      summary({ id: 'attn', status: 'plan_ready', updatedAt: '2026-07-07T09:00:00.000Z' }),
    ]);
    renderHome();

    // T6.1b: the run list is a real table now — rows live in the body rowgroup.
    const table = await screen.findByRole('table');
    const body = within(table).getAllByRole('rowgroup')[1]!;
    const rows = within(body).getAllByRole('row');
    expect(rows.map((r) => within(r).getByText(/^Run /).textContent)).toEqual([
      'Run attn',
      'Run busy',
      'Run done',
    ]);
    // Next-action labels come from the pure helper (§7.1).
    expect(screen.getByRole('button', { name: 'Approve plan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open report' })).toBeInTheDocument();
  });

  it('resolves the board name from the profiles list', async () => {
    listRuns.mockResolvedValue([summary({ id: 'r1', status: 'running' })]);
    listBoardProfiles.mockResolvedValue([
      { id: 'bp_nucleo_f303re', name: 'Nucleo-F303RE' } as BoardProfile,
    ]);
    renderHome();
    expect(await screen.findByText('Nucleo-F303RE')).toBeInTheDocument();
  });

  it('renders the offline banner but still shows the cached list when the runner is down', async () => {
    getHealth.mockResolvedValue({ ...online, ok: false });
    listRuns.mockResolvedValue([summary({ id: 'r1', status: 'running' })]);
    renderHome();

    // The cached list still renders while the runner is down (§7.1)...
    expect(await screen.findByText('Run r1')).toBeInTheDocument();
    // ...beneath the offline banner.
    expect(screen.getByText('Runner offline')).toBeInTheDocument();
  });
});

// Advisory bench indicator (T4.2): a compact line under the banner slot, linking to
// /boards. It never gates anything on this screen.
describe('HomePage bench indicator', () => {
  beforeEach(() => {
    listRuns.mockResolvedValue([summary({ id: 'r1', status: 'running' })]);
  });

  it('stays silent when every device is online', async () => {
    renderHome();
    expect(await screen.findByText('Run r1')).toBeInTheDocument();
    expect(screen.queryByText(/needs attention|need attention/)).not.toBeInTheDocument();
  });

  it.each([
    [['offline'] as const, '1 instrument needs attention'],
    [['error'] as const, '1 instrument needs attention'],
    [['offline', 'error'] as const, '2 instruments need attention'],
  ])('counts non-online devices and links to /boards', async (states, label) => {
    getBench.mockResolvedValue(bench(...states));
    renderHome();

    const link = await screen.findByRole('link', { name: label });
    expect(link).toHaveAttribute('href', '/boards');
  });

  it('prefers the live runner.status snapshot over the GET /bench fallback', async () => {
    getBench.mockResolvedValue(bench('online'));
    useBenchStore.getState().setBench(bench('offline'));
    renderHome();
    expect(await screen.findByRole('link', { name: '1 instrument needs attention' })).toBeInTheDocument();
  });

  // F1(ii): the socket is the liveness signal, not /health. HTTP can be perfectly
  // healthy while the stream that would have told us the analyzer came back is dead.
  it('drops the snapshot when the socket leaves open, even with /health green', async () => {
    let resolveBench: ((value: BenchStatus) => void) | undefined;
    getBench.mockReturnValue(new Promise<BenchStatus>((resolve) => (resolveBench = resolve)));
    useBenchStore.getState().setBench(bench('offline'));
    renderHome();

    expect(await screen.findByText('1 instrument needs attention')).toBeInTheDocument();

    emitWsStatus('reconnecting');
    await waitFor(() =>
      expect(screen.queryByText('1 instrument needs attention')).not.toBeInTheDocument(),
    );
    expect(getHealth).toHaveBeenCalled(); // /health never went red
    expect(resolveBench).toBeDefined(); // the fallback re-fetches under a fresh generation
  });

  // F1(i): a runner coming back on /health proves HTTP works, not that the bench is
  // what we last saw. Only a snapshot that postdates the current connection does.
  it('stays suppressed after health recovers until a fresh snapshot lands', async () => {
    // The bench GET hangs, so nothing can re-fill the snapshot but a live runner.status.
    getBench.mockReturnValue(new Promise<BenchStatus>(() => undefined));
    getHealth.mockResolvedValue({ ...online, ok: false });
    useBenchStore.getState().setBench(bench('offline')); // stale: from the old connection
    renderHome();

    emitWsStatus('reconnecting');
    await waitFor(() =>
      expect(screen.queryByText('1 instrument needs attention')).not.toBeInTheDocument(),
    );

    // /health flips green. On its own that must change nothing here.
    getHealth.mockResolvedValue(online);
    await waitFor(() => expect(screen.queryByText('Runner offline')).not.toBeInTheDocument(), {
      timeout: 10000,
    });
    expect(screen.queryByText('1 instrument needs attention')).not.toBeInTheDocument();

    // A fresh runner.status over the re-opened socket is what brings it back.
    emitWsStatus('open');
    act(() => useBenchStore.getState().setBench(bench('offline')));
    expect(await screen.findByText('1 instrument needs attention')).toBeInTheDocument();
  }, 15000);
});
