// Sidebar recent-runs onboarding (T6.5, P4). The "Watch a demo run" affordance appears
// only on a GENUINE empty runs response (runsQuery.isSuccess) — never while the fetch is
// still pending or after it failed — matching Home's first-use hero. A cold start with
// the runner down must not misread "we haven't loaded any runs yet" as "there are no
// runs, watch the demo".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { HealthResponse, RunSummary } from '@boardex/contract';

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
}));

import { Sidebar } from './Sidebar';

const DEMO_LINK = 'Watch a demo run';

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getHealth.mockResolvedValue({ ok: true, contractVersion: 'boardex-contract/0.1', runnerKind: 'mock' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Sidebar "Watch a demo run" gating (P4)', () => {
  it('shows the demo link on a genuine empty runs response', async () => {
    listRuns.mockResolvedValue([]);
    renderSidebar();
    expect(await screen.findByRole('link', { name: DEMO_LINK })).toBeInTheDocument();
  });

  it('does not show it while the runs fetch is still pending', () => {
    // A never-resolving fetch keeps the query pending: no demo link yet.
    listRuns.mockReturnValue(new Promise<RunSummary[]>(() => {}));
    renderSidebar();
    expect(screen.queryByRole('link', { name: DEMO_LINK })).toBeNull();
  });

  it('does not show it when the runs fetch fails (cold start, runner down)', async () => {
    listRuns.mockRejectedValue(new Error('runner offline'));
    renderSidebar();
    // Let the query settle into error; the demo link must never appear.
    await waitFor(() => expect(listRuns).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: DEMO_LINK })).toBeNull();
  });

  it('shows the recent list instead of the demo link once runs exist', async () => {
    listRuns.mockResolvedValue([
      { id: 'r1', title: 'BME280 bring-up', status: 'running', boardProfileId: 'bp', updatedAt: '2026-07-14T10:00:00Z' },
    ]);
    renderSidebar();
    expect(await screen.findByRole('list', { name: 'Recent runs' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: DEMO_LINK })).toBeNull();
  });
});
