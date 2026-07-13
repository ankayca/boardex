import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { RunSummary } from '@boardex/contract';

const listRuns = vi.fn<() => Promise<RunSummary[]>>();
const listBoardProfiles = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    listRuns: () => listRuns(),
    listBoardProfiles: () => listBoardProfiles(),
  },
}));

vi.mock('../lib/runStore', () => ({
  useRunView: () => null,
}));

import { CommandCenter } from './CommandCenter';

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function Harness({ initial = '/' }: { initial?: string }) {
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <MemoryRouter initialEntries={[initial]}>
      <div ref={contentRef} tabIndex={-1} data-testid="content" />
      <input data-testid="field" aria-label="a field" />
      <button data-testid="opener">opener</button>
      <CommandCenter contentRef={contentRef} />
      <LocationProbe />
    </MemoryRouter>
  );
}

function renderHarness(initial = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness initial={initial} />
    </QueryClientProvider>,
  );
}

function location() {
  return screen.getByTestId('location').textContent;
}

beforeEach(() => {
  listRuns.mockResolvedValue([]);
  listBoardProfiles.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CommandCenter global shortcuts', () => {
  it('g r goes to Runs', async () => {
    const user = userEvent.setup();
    renderHarness('/boards');
    await user.keyboard('gr');
    expect(location()).toBe('/');
  });

  it('g b goes to Boards', async () => {
    const user = userEvent.setup();
    renderHarness('/');
    await user.keyboard('gb');
    expect(location()).toBe('/boards');
  });

  it('n starts a new run from a list page', async () => {
    const user = userEvent.setup();
    renderHarness('/');
    await user.keyboard('n');
    expect(location()).toBe('/runs/new');
  });

  it('n does nothing from inside a run (not a list page)', async () => {
    const user = userEvent.setup();
    renderHarness('/runs/r1');
    await user.keyboard('n');
    expect(location()).toBe('/runs/r1');
  });

  it('suppresses bare shortcuts while an input has focus', async () => {
    const user = userEvent.setup();
    renderHarness('/');
    await user.click(screen.getByTestId('field'));
    await user.keyboard('n');
    // Typed into the field, not treated as New Run.
    expect(location()).toBe('/');
    await user.keyboard('gr');
    expect(location()).toBe('/');
    await user.keyboard('?');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
  });

  it('⌘K opens the command palette from anywhere, even inside an input', async () => {
    const user = userEvent.setup();
    renderHarness('/');
    await user.click(screen.getByTestId('field'));
    await user.keyboard('{Meta>}k{/Meta}');
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('? opens the shortcuts help overlay', async () => {
    const user = userEvent.setup();
    renderHarness('/');
    await user.keyboard('?');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('restores focus to the opener when the palette is dismissed', async () => {
    const user = userEvent.setup();
    renderHarness('/');
    const opener = screen.getByTestId('opener');
    opener.focus();
    await user.keyboard('{Meta>}k{/Meta}');
    // Palette took focus; dismissing returns it to the opener.
    await user.keyboard('{Escape}');
    expect(opener).toHaveFocus();
  });
});
