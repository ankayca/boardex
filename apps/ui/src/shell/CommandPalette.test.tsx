import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { BoardProfile, RunSummary, RunView } from '@boardex/contract';

// The full command surface is spied so the "never executes" test can assert that NO
// state-changing command is reachable from any palette entry.
const listRuns = vi.fn<() => Promise<RunSummary[]>>();
const listBoardProfiles = vi.fn<() => Promise<BoardProfile[]>>();
const approvePlan = vi.fn();
const resolveApproval = vi.fn();
const stopRun = vi.fn();
const createRun = vi.fn();
const saveBoardProfile = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    listRuns: () => listRuns(),
    listBoardProfiles: () => listBoardProfiles(),
    approvePlan: (...args: unknown[]) => approvePlan(...args),
    resolveApproval: (...args: unknown[]) => resolveApproval(...args),
    stopRun: (...args: unknown[]) => stopRun(...args),
    createRun: (...args: unknown[]) => createRun(...args),
    saveBoardProfile: (...args: unknown[]) => saveBoardProfile(...args),
  },
}));

// runStore mutators are spied too (F3): the palette is a pure navigator, so it must
// never ingest events or reset a run store. Named with the `mock` prefix so the hoisted
// vi.mock factory may reference them.
const mockIngest = vi.fn();
const mockIngestMany = vi.fn();
const mockReset = vi.fn();
const mockResetAll = vi.fn();
const STORE_MUTATORS = [mockIngest, mockIngestMany, mockReset, mockResetAll];

let mockView: RunView | null = null;
vi.mock('../lib/runStore', () => {
  // Built lazily inside getState so the spies are read at call time (during a test),
  // not when this factory runs at import — they aren't initialized until later.
  const getState = () => ({
    ingest: mockIngest,
    ingestMany: mockIngestMany,
    reset: mockReset,
    resetAll: mockResetAll,
  });
  const useRunStore = Object.assign(
    (selector?: (s: ReturnType<typeof getState>) => unknown) =>
      selector ? selector(getState()) : getState(),
    { getState },
  );
  return {
    useRunStore,
    useRunView: (runId: string) => (runId ? mockView : null),
  };
});

import { CommandPalette } from './CommandPalette';

const STATE_CHANGING = [approvePlan, resolveApproval, stopRun, createRun, saveBoardProfile];

function run(id: string, title: string): RunSummary {
  return { id, title, status: 'running', boardProfileId: 'bp', updatedAt: '2026-07-12T10:00:00Z' };
}

function profile(id: string, name: string, mcu: string): BoardProfile {
  return { id, name, mcu } as BoardProfile;
}

// A view whose artifacts/checks light up every in-run contextual entry.
function fullRunView(): RunView {
  return {
    checks: [{ id: 'c1', verdict: 'pass', artifactId: 'a-log', requirementId: 'i2c_clock' }],
    artifacts: [
      { id: 'a-log', kind: 'serial_log' },
      { id: 'a-diff', kind: 'code_diff' },
      { id: 'a-report', kind: 'report_md' },
    ],
  } as unknown as RunView;
}

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname + useLocation().search}</div>;
}

function renderPalette(
  onClose = vi.fn<(reason: 'dismiss' | 'navigate') => void>(),
  path = '/',
): { onClose: typeof onClose } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <CommandPalette onClose={onClose} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  listRuns.mockResolvedValue([]);
  listBoardProfiles.mockResolvedValue([]);
  mockView = null;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('CommandPalette', () => {
  it('opens with the search input focused', async () => {
    renderPalette();
    const input = screen.getByRole('combobox');
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('closes on Esc as a dismiss', () => {
    const { onClose } = renderPalette();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith('dismiss');
  });

  it('closes as a dismiss on backdrop click', () => {
    const { onClose } = renderPalette();
    const scrim = screen.getByRole('dialog').previousElementSibling as HTMLElement;
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledWith('dismiss');
  });

  it('traps Tab so focus never leaves the open palette', () => {
    renderPalette();
    const input = screen.getByRole('combobox');
    input.focus();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveFocus();
  });

  it('fuzzy-filters and ranks results, matching a run by title', async () => {
    listRuns.mockResolvedValue([run('r1', 'BME280 bring-up'), run('r2', 'Blink smoke test')]);
    const user = userEvent.setup();
    renderPalette();
    await screen.findByRole('option', { name: /BME280 bring-up/ });

    await user.type(screen.getByRole('combobox'), 'bme2');

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('BME280 bring-up');
  });

  it('navigates on Enter and reports a navigate close', async () => {
    listRuns.mockResolvedValue([run('r1', 'BME280 bring-up')]);
    const user = userEvent.setup();
    const { onClose } = renderPalette();
    await screen.findByRole('option', { name: /BME280 bring-up/ });

    await user.type(screen.getByRole('combobox'), 'bme');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    expect(onClose).toHaveBeenCalledWith('navigate');
    expect(screen.getByTestId('location')).toHaveTextContent('/runs/r1');
  });

  it('moves the active option with the arrow keys', async () => {
    listRuns.mockResolvedValue([run('r1', 'BME280 bring-up')]);
    renderPalette();
    await screen.findByRole('option', { name: /BME280 bring-up/ });

    const input = screen.getByRole('combobox');
    // First option (Runs nav) starts selected.
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('NEVER executes a state-changing command from any entry (spied api, fetch, and store)', async () => {
    // The api layer is fully mocked, so ANY fetch from the palette is illegitimate;
    // the store mutators must never fire from a pure navigator either (F3).
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    // Every source populated, opened inside a run so contextual entries appear too.
    listRuns.mockResolvedValue([run('r1', 'BME280 bring-up')]);
    listBoardProfiles.mockResolvedValue([profile('bp1', 'Nucleo-F303RE', 'STM32F303RE')]);
    mockView = fullRunView();
    const user = userEvent.setup();
    renderPalette(vi.fn(), '/runs/r1');
    // Wait for the async sources so the contextual + recent + board entries exist.
    await screen.findByRole('option', { name: /Open Evidence/ });
    await screen.findByRole('option', { name: /BME280 bring-up/ });
    await screen.findByRole('option', { name: /Nucleo-F303RE/ });

    // Activate EVERY entry the palette can reach.
    for (const option of screen.getAllByRole('option')) {
      await user.click(option);
    }

    for (const spy of STATE_CHANGING) {
      expect(spy).not.toHaveBeenCalled();
    }
    for (const mutator of STORE_MUTATORS) {
      expect(mutator).not.toHaveBeenCalled();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows contextual entries only when their artifact exists (gating)', async () => {
    mockView = {
      checks: [],
      artifacts: [{ id: 'a-log', kind: 'serial_log' }],
    } as unknown as RunView;
    renderPalette(vi.fn(), '/runs/r1');
    await screen.findByRole('option', { name: /Open Logs/ });

    const list = screen.getByRole('listbox');
    // Only Logs — no checks (no Evidence), no diff/report artifacts (no Diff/Report).
    expect(within(list).queryByRole('option', { name: /Open Evidence/ })).toBeNull();
    expect(within(list).queryByRole('option', { name: /Open Diff/ })).toBeNull();
    expect(within(list).queryByRole('option', { name: /Open Report/ })).toBeNull();
  });
});
