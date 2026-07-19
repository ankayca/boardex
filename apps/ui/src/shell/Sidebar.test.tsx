// Sidebar recent-runs onboarding. Demo-affordance cleanup (Sprint 7 P1 #1): the demo
// entry is prominent on Home's empty-state hero, so the sidebar no longer duplicates it
// there — the sidebar "Watch a demo run" link renders only AFTER runs exist, alongside
// the recent list. On empty / pending / failed responses the sidebar shows no demo link
// (the hero owns that entry on the empty state).
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

const aRun: RunSummary = {
  id: 'r1',
  title: 'BME280 bring-up',
  status: 'running',
  boardProfileId: 'bp',
  updatedAt: '2026-07-14T10:00:00Z',
};

describe('Sidebar "Watch a demo run" cleanup (P1 #1)', () => {
  it('does not show the demo link on a genuine empty runs response (the hero owns it)', async () => {
    listRuns.mockResolvedValue([]);
    renderSidebar();
    // Let the empty response settle; the sidebar stays quiet — no duplicate demo entry.
    await waitFor(() => expect(listRuns).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: DEMO_LINK })).toBeNull();
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

  it('shows the recent list AND the demo link once runs exist', async () => {
    listRuns.mockResolvedValue([aRun]);
    renderSidebar();
    expect(await screen.findByRole('list', { name: 'Recent runs' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: DEMO_LINK })).toHaveAttribute('href', '/demo');
  });
});
