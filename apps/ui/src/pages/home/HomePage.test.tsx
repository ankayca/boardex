import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { BoardProfile, HealthResponse, RunSummary } from '@boardex/contract';

// Mock the HTTP client: HomePage's job is to turn these responses into the right
// screen state (loading / empty / populated / offline), which is what we assert.
const getHealth = vi.fn<() => Promise<HealthResponse>>();
const listRuns = vi.fn<() => Promise<RunSummary[]>>();
const listBoardProfiles = vi.fn<() => Promise<BoardProfile[]>>();

vi.mock('../../lib/api', () => ({
  api: {
    getHealth: () => getHealth(),
    listRuns: () => listRuns(),
    listBoardProfiles: () => listBoardProfiles(),
  },
}));

import HomePage from './HomePage';

const online: HealthResponse = { ok: true, contractVersion: 'boardex-contract/0.1', runnerKind: 'mock' };

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
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('HomePage (BIBLE §7.1)', () => {
  it('shows the first-use hero when there are no runs', async () => {
    listRuns.mockResolvedValue([]);
    renderHome();
    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
    // Both the header and the hero point at New Run.
    expect(screen.getAllByRole('button', { name: 'New Run' }).length).toBeGreaterThanOrEqual(2);
  });

  it('orders needs-attention runs above active and terminal ones', async () => {
    listRuns.mockResolvedValue([
      summary({ id: 'done', status: 'completed', updatedAt: '2026-07-07T13:00:00.000Z' }),
      summary({ id: 'busy', status: 'running', updatedAt: '2026-07-07T12:30:00.000Z' }),
      summary({ id: 'attn', status: 'plan_ready', updatedAt: '2026-07-07T09:00:00.000Z' }),
    ]);
    renderHome();

    const rows = await screen.findAllByRole('listitem');
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
