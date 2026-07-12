import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { HealthResponse, RunSummary, RunView } from '@boardex/contract';

const getHealth = vi.fn<() => Promise<HealthResponse>>();
const listRuns = vi.fn<() => Promise<RunSummary[]>>();

vi.mock('../lib/api', () => ({
  api: {
    getHealth: () => getHealth(),
    listRuns: () => listRuns(),
  },
}));

vi.mock('../lib/globalStream', () => ({
  useGlobalEvents: () => undefined,
  subscribeGlobal: () => () => undefined,
  subscribeGlobalStatus: () => () => undefined,
  globalStatus: () => 'open',
}));

// TopBar reads the run title/status from the reduced view (D5) by id.
let mockView: RunView | null = null;
vi.mock('../lib/runStore', () => ({
  useRunView: (runId: string) => (runId ? mockView : null),
}));

import { recentRuns } from './recentRuns';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

const online: HealthResponse = {
  ok: true,
  contractVersion: 'boardex-contract/0.1',
  runnerKind: 'mock',
};

function summary(id: string, updatedAt: string, status: RunSummary['status'] = 'running'): RunSummary {
  return { id, title: `Run ${id}`, status, boardProfileId: 'bp', updatedAt };
}

function renderAt(path: string, ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getHealth.mockResolvedValue(online);
  listRuns.mockResolvedValue([]);
  mockView = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('recentRuns', () => {
  it('orders by plain recency and keeps five', () => {
    const runs = [
      summary('a', '2026-07-10T10:00:00Z'),
      summary('b', '2026-07-12T10:00:00Z'),
      summary('c', '2026-07-11T10:00:00Z'),
      summary('d', '2026-07-09T10:00:00Z'),
      summary('e', '2026-07-08T10:00:00Z'),
      summary('f', '2026-07-07T10:00:00Z'),
    ];
    expect(recentRuns(runs).map((run) => run.id)).toEqual(['b', 'c', 'a', 'd', 'e']);
  });
});

describe('Sidebar (frame v2)', () => {
  it('renders primary nav with the route-derived active state', () => {
    renderAt('/boards', <Sidebar />);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: /Runs/ })).not.toHaveAttribute(
      'aria-current',
    );
    expect(within(nav).getByRole('link', { name: /Boards/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('lists the five most recent runs with status glyphs, live from ["runs"]', async () => {
    listRuns.mockResolvedValue([
      summary('old', '2026-07-08T10:00:00Z', 'completed'),
      summary('new', '2026-07-12T10:00:00Z', 'awaiting_approval'),
    ]);
    renderAt('/', <Sidebar />);
    const recent = await screen.findByRole('list', { name: 'Recent runs' });
    const links = within(recent).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Run new', 'Run old']);
    expect(links[0]!.querySelector('[data-status="awaiting_approval"]')).not.toBeNull();
  });

  it('shows the runner pill at the bottom from /health', async () => {
    renderAt('/', <Sidebar />);
    expect(await screen.findByText('Runner online · mock')).toBeInTheDocument();
  });

  it('collapses to an icon rail and back, hiding labels but keeping nav', async () => {
    const user = userEvent.setup();
    renderAt('/', <Sidebar />);
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.queryByText('Boardex')).not.toBeInTheDocument();
    // Nav survives as icons with accessible names via title attributes.
    expect(screen.getByRole('link', { name: 'Runs' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(screen.getByText('Boardex')).toBeInTheDocument();
  });
});

describe('TopBar (frame v2)', () => {
  it('shows Runs + the New Run action on Home', () => {
    renderAt('/', <TopBar />);
    expect(screen.getByRole('heading', { name: 'Runs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Run' })).toBeInTheDocument();
  });

  it('shows Board Profiles + the New Profile action on /boards', () => {
    renderAt('/boards', <TopBar />);
    expect(screen.getByRole('heading', { name: 'Board Profiles' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Profile' })).toBeInTheDocument();
  });

  it('shows the composer title with no actions on /runs/new', () => {
    renderAt('/runs/new', <TopBar />);
    expect(screen.getByRole('heading', { name: 'New Run' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the run title + status badge from the reduced view on run routes', () => {
    mockView = {
      run: { title: 'BME280 bring-up', status: 'running' },
    } as RunView;
    renderAt('/runs/r1', <TopBar />);
    expect(screen.getByRole('heading', { name: 'BME280 bring-up' })).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('falls back while the run view is still connecting', () => {
    mockView = null;
    renderAt('/runs/r1/report', <TopBar />);
    expect(screen.getByRole('heading', { name: 'Run' })).toBeInTheDocument();
  });
});
