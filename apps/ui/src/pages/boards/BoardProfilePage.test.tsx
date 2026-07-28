// /boards and /boards/:id route states (BIBLE §7.5). The load-failure state is the
// point of this file: a builder that cannot load its profile must show the blocked
// pattern, never an editable form that would POST blanks over a real profile.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BoardProfileSchema, type BenchStatus, type BoardProfile } from '@boardex/contract';

const listBoardProfiles = vi.fn<() => Promise<BoardProfile[]>>();
const getBench = vi.fn<() => Promise<BenchStatus>>();
const saveBoardProfile = vi.fn<(profile: BoardProfile) => Promise<BoardProfile>>();

vi.mock('../../lib/api', () => ({
  api: {
    listBoardProfiles: () => listBoardProfiles(),
    getBench: () => getBench(),
    saveBoardProfile: (profile: BoardProfile) => saveBoardProfile(profile),
  },
}));

// ProfileForm's picker reads the bench through useBenchStatus (T5.0/F8); stub the
// global socket inert so its reconnect churn cannot bump the snapshot generation
// mid-test (liveness itself is covered by benchLiveness.integration.test.tsx).
vi.mock('../../lib/globalStream', () => ({
  subscribeGlobalStatus: () => () => undefined,
}));

import BoardProfilePage from './BoardProfilePage';
import BoardsPage from './BoardsPage';

const PROFILE: BoardProfile = BoardProfileSchema.parse({
  id: 'bp_nucleo_f303re',
  name: 'Nucleo-F303RE',
  mcu: 'STM32F303RE (Cortex-M4)',
  repoPath: '/bench/firmware/bme280-f303re',
  buildCommand: 'make clean && make',
  flashCommand: 'pyocd flash --target stm32f303retx bme280.elf',
  resetCommand: 'pyocd reset --target stm32f303retx',
  serial: { port: '/dev/ttyACM0', baud: 115200 },
  instruments: {
    debugProbe: 'pyocd:stlink:066EFF383733554157254923',
    logicAnalyzer: 'sigrok:kingst-la2016:conn=3.12',
  },
  safety: { maxIterations: 3, flashRequiresApproval: true, powerNote: '3V3 confirmed.' },
  connectionChecklist: [{ label: 'SCL — PB8', detail: 'PB8 to BME280 SCL' }],
  knownQuirks: [],
});

function renderAt(path: string): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/boards" element={<BoardsPage />} />
          <Route path="/boards/new" element={<BoardProfilePage />} />
          <Route path="/boards/:id" element={<BoardProfilePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('/boards/:id — fail-closed on load failure', () => {
  it('blocks with the amber pattern when the profile list cannot be fetched', async () => {
    listBoardProfiles.mockRejectedValue(new TypeError('Failed to fetch'));
    renderAt('/boards/bp_nucleo_f303re');

    const blocked = await screen.findByRole('alert');
    expect(blocked).toHaveTextContent('Board profile unavailable');
    expect(blocked).toHaveTextContent(/overwrite settings that are not on screen/);
    // No editable form, and nothing that could POST over the real profile.
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Profile/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('blocks when the runner has no profile with that id', async () => {
    listBoardProfiles.mockResolvedValue([]);
    renderAt('/boards/bp_ghost');

    const blocked = await screen.findByRole('alert');
    expect(blocked).toHaveTextContent('Board profile not found');
    expect(blocked).toHaveTextContent('bp_ghost');
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('shows a loading state — never a blank form — while the profile is in flight', () => {
    listBoardProfiles.mockReturnValue(new Promise(() => {}));
    renderAt('/boards/bp_nucleo_f303re');

    expect(screen.getByRole('status')).toHaveTextContent('Loading the board profile…');
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('renders the form prefilled once the profile resolves', async () => {
    listBoardProfiles.mockResolvedValue([PROFILE]);
    getBench.mockRejectedValue(new TypeError('no bench'));
    renderAt('/boards/bp_nucleo_f303re');

    expect(await screen.findByLabelText('Name')).toHaveValue('Nucleo-F303RE');
    expect(screen.getByLabelText('Build command')).toHaveValue('make clean && make');
    expect(screen.getByLabelText('Baud')).toHaveValue('115200');
    expect(screen.getByRole('button', { name: 'Save Profile' })).toBeInTheDocument();
  });

  // Review F1: the fail-closed guard keys on "no profile in hand", not "the last fetch
  // failed". Once a profile is loaded, a failed refetch must not unmount the form and
  // take the user's unsaved edits with it.
  it('keeps the form and its unsaved edits when a refetch fails after a successful load', async () => {
    const user = userEvent.setup();
    listBoardProfiles.mockResolvedValueOnce([PROFILE]);
    getBench.mockRejectedValue(new TypeError('no bench'));
    const client = renderAt('/boards/bp_nucleo_f303re');

    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Nucleo-F303RE (bench 2)');

    // A background refetch — the runner has gone away since the first load.
    listBoardProfiles.mockRejectedValue(new TypeError('Failed to fetch'));
    await client.refetchQueries({ queryKey: ['board-profiles'] });

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /Couldn’t refresh from the runner — you’re editing the last loaded copy/,
      ),
    );
    // Form intact, edit intact, no blocked card.
    expect(screen.getByLabelText('Name')).toHaveValue('Nucleo-F303RE (bench 2)');
    expect(screen.getByRole('button', { name: 'Save Profile' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('/boards/new', () => {
  it('opens an empty form without reading any profile', async () => {
    getBench.mockRejectedValue(new TypeError('no bench'));
    renderAt('/boards/new');

    expect(await screen.findByRole('button', { name: 'Create Profile' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(listBoardProfiles).not.toHaveBeenCalled();
  });

  it('is the builder, not a profile whose id is "new"', () => {
    getBench.mockRejectedValue(new TypeError('no bench'));
    renderAt('/boards/new');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New board profile');
  });
});

describe('/boards — the profile list', () => {
  it('lists name, MCU, instruments and an edit link per profile', async () => {
    listBoardProfiles.mockResolvedValue([PROFILE]);
    renderAt('/boards');

    const list = await screen.findByRole('list', { name: 'Board profiles' });
    expect(list).toHaveTextContent('Nucleo-F303RE');
    expect(list).toHaveTextContent('STM32F303RE (Cortex-M4)');
    expect(list).toHaveTextContent(
      'pyocd:stlink:066EFF383733554157254923 · sigrok:kingst-la2016:conn=3.12',
    );
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/boards/bp_nucleo_f303re',
    );
    // T6.1b: the header New Profile action moved to the shell's top bar
    // (Shell.test); the list page itself carries no header button.
    expect(screen.queryByRole('button', { name: 'New Profile' })).not.toBeInTheDocument();
  });

  it('offers the empty state when the runner knows no profiles, leading with Quick Start', async () => {
    listBoardProfiles.mockResolvedValue([]);
    renderAt('/boards');

    expect(await screen.findByText('No board profiles yet')).toBeInTheDocument();
    // Quick Start v0: the empty state leads with the two-field flow (primary) and
    // keeps the full seven-section form one click away as Advanced setup. T6.1b's
    // rule still holds — the page's own header action lives in the shell's top bar,
    // so these two buttons are the hero's, and there is no "New Profile" beside them.
    expect(screen.getByRole('button', { name: 'Quick Start' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Advanced setup' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Profile' })).not.toBeInTheDocument();
  });

  it('surfaces a failed fetch with a retry, not an empty list', async () => {
    listBoardProfiles.mockRejectedValue(new TypeError('Failed to fetch'));
    renderAt('/boards');

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load board profiles');
    expect(screen.queryByText('No board profiles yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
