// /boards and /boards/:id route states (BIBLE §7.5). The load-failure state is the
// point of this file: a builder that cannot load its profile must show the blocked
// pattern, never an editable form that would POST blanks over a real profile.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    debugProbe: 'ST-Link/V2-1 (on-board, via pyOCD)',
    logicAnalyzer: 'Kingst LA2016 (sigrok)',
  },
  safety: { maxIterations: 3, flashRequiresApproval: true, powerNote: '3V3 confirmed.' },
  connectionChecklist: [{ label: 'SCL — PB8', detail: 'PB8 to BME280 SCL' }],
  knownQuirks: [],
});

function renderAt(path: string) {
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
    expect(list).toHaveTextContent('ST-Link/V2-1 (on-board, via pyOCD) · Kingst LA2016 (sigrok)');
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/boards/bp_nucleo_f303re',
    );
    expect(screen.getByRole('button', { name: 'New Profile' })).toBeInTheDocument();
  });

  it('offers the empty state when the runner knows no profiles', async () => {
    listBoardProfiles.mockResolvedValue([]);
    renderAt('/boards');

    expect(await screen.findByText('No board profiles yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New Profile' })).toHaveLength(2);
  });

  it('surfaces a failed fetch with a retry, not an empty list', async () => {
    listBoardProfiles.mockRejectedValue(new TypeError('Failed to fetch'));
    renderAt('/boards');

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load board profiles');
    expect(screen.queryByText('No board profiles yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
