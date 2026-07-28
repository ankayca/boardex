// Quick Start v0 in the composer (BIBLE §7.2): the two-field panel, its advisory
// inline path states, the feature-detected probe, the recents chips, and the one-click
// "compile a profile, then create the run against it" assembly. The api seam and the
// (non-contract) workspace probe are stubbed; the live end-to-end path is the composer
// integration test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { BenchStatus, BoardProfile } from '@boardex/contract';
import { api } from '../../lib/api';
import { addRecentRepoPath, getRecentRepoPaths, resetSettingsMemory } from '../../lib/settings';
import { workspaceApi } from '../../lib/workspaceValidate';
import NewRunPage from './NewRunPage';

const BENCH: BenchStatus = {
  runnerOnline: true,
  contractVersion: 'boardex-contract/0.1',
  devices: [
    {
      id: 'pyocd:stlink:1',
      kind: 'debug_probe',
      name: 'ST-Link/V2-1',
      state: 'online',
      detail: 'stm32f303retx',
    },
  ],
};

const EXISTING: BoardProfile = {
  id: 'bp_nucleo_f303re',
  name: 'Nucleo-F303RE',
  mcu: 'STM32F303RE',
  repoPath: '/bench/firmware',
  buildCommand: 'make',
  flashCommand: 'pyocd flash fw.elf',
  resetCommand: 'pyocd reset',
  serial: { port: '/dev/ttyACM0', baud: 115200 },
  instruments: { debugProbe: 'pyocd:stlink:1' },
  safety: { maxIterations: 3, flashRequiresApproval: true, powerNote: '3V3 confirmed.' },
  connectionChecklist: [],
  knownQuirks: [],
};

function setup({ profiles = [] as BoardProfile[] } = {}) {
  vi.spyOn(api, 'listBoardProfiles').mockResolvedValue(profiles);
  vi.spyOn(api, 'getBench').mockResolvedValue(BENCH);
  vi.spyOn(api, 'getHealth').mockResolvedValue({
    ok: true,
    contractVersion: 'boardex-contract/0.1',
    runnerKind: 'mock',
  });
  const saveBoardProfile = vi
    .spyOn(api, 'saveBoardProfile')
    .mockImplementation(async (profile) => profile);
  const createRun = vi.spyOn(api, 'createRun').mockResolvedValue({ runId: 'run_quickstart' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs/new']}>
        <NewRunPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { saveBoardProfile, createRun };
}

const pathInput = () => screen.getByLabelText('Repo path');

/** Type a path and blur it — validation is on blur (§7.2 v0). */
async function enterPath(user: ReturnType<typeof userEvent.setup>, path: string) {
  await user.click(pathInput());
  await user.paste(path);
  await user.tab();
}

beforeEach(() => {
  vi.spyOn(workspaceApi, 'validate').mockResolvedValue({ status: 'unsupported' });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSettingsMemory();
});

describe('Quick Start panel — when it leads', () => {
  it('leads with Quick Start when the runner knows no profiles (no empty dropdown)', async () => {
    setup();
    expect(await screen.findByRole('region', { name: 'Quick Start' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /board profile/i })).not.toBeInTheDocument();
    // The panel explains itself in one sentence.
    expect(
      screen.getByText(/Point Boardex at your firmware folder/),
    ).toBeInTheDocument();
    // …and is honest about the seeded checklist being generic (D12, 2026-07-28).
    expect(screen.getByText(/generic defaults — refine them in Advanced/)).toBeInTheDocument();
  });

  it('is reachable from "+ New board" when profiles exist, and hands back', async () => {
    const user = userEvent.setup();
    setup({ profiles: [EXISTING] });

    await screen.findByRole('option', { name: 'Nucleo-F303RE' });
    expect(screen.queryByRole('region', { name: 'Quick Start' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '+ New board' }));
    expect(screen.getByRole('region', { name: 'Quick Start' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use an existing board' }));
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('offers no way back when there is no existing board to go back to', async () => {
    setup();
    await screen.findByRole('region', { name: 'Quick Start' });
    expect(screen.queryByRole('button', { name: 'Use an existing board' })).not.toBeInTheDocument();
  });
});

describe('Quick Start path validation — advisory, never blocking', () => {
  it('green: a firmware folder reports the detected build command', async () => {
    const user = userEvent.setup();
    vi.spyOn(workspaceApi, 'validate').mockResolvedValue({
      status: 'validated',
      result: { ok: true, exists: true, kind: 'firmware', detectedBuild: 'make' },
    });
    setup();
    await screen.findByRole('region', { name: 'Quick Start' });

    await enterPath(user, '/bench/firmware/bme280-f303re');
    expect(await screen.findByText(/Firmware folder found on the runner/)).toBeInTheDocument();
    expect(screen.getByText('make')).toBeInTheDocument();
  });

  it('amber: a suggested subdirectory is one click away, and re-validates on accept', async () => {
    const user = userEvent.setup();
    const validate = vi
      .spyOn(workspaceApi, 'validate')
      .mockResolvedValueOnce({
        status: 'validated',
        result: {
          ok: false,
          exists: true,
          kind: 'directory',
          suggestedPath: '/bench/repos/sensors/firmware',
          detectedBuild: 'make',
        },
      })
      .mockResolvedValue({
        status: 'validated',
        result: { ok: true, exists: true, kind: 'firmware', detectedBuild: 'make' },
      });
    setup();
    await screen.findByRole('region', { name: 'Quick Start' });

    await enterPath(user, '/bench/repos/sensors');
    expect(await screen.findByText(/The firmware looks like it is in/)).toBeInTheDocument();
    expect(screen.getByText('/bench/repos/sensors/firmware')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use this path' }));
    expect(pathInput()).toHaveValue('/bench/repos/sensors/firmware');
    expect(await screen.findByText(/Firmware folder found on the runner/)).toBeInTheDocument();
    expect(validate).toHaveBeenLastCalledWith('/bench/repos/sensors/firmware');
  });

  it('red: a path the runner cannot find says so honestly — and still lets the run be created', async () => {
    const user = userEvent.setup();
    vi.spyOn(workspaceApi, 'validate').mockResolvedValue({
      status: 'validated',
      result: { ok: false, exists: false, kind: 'missing' },
    });
    const { createRun } = setup();
    await screen.findByRole('region', { name: 'Quick Start' });

    await enterPath(user, '/typo/firmware');
    expect(await screen.findByText('Not found on the runner.')).toBeInTheDocument();

    // Advisory, exactly like a bench reference: composing and creating stay allowed.
    await user.click(screen.getByRole('textbox', { name: 'Ask Boardex' }));
    await user.paste('bring up the BME280');
    const create = screen.getByRole('button', { name: 'Create Run Plan' });
    expect(create).toBeEnabled();
    await user.click(create);
    await waitFor(() => expect(createRun).toHaveBeenCalledTimes(1));
  });

  it('a file is not a folder — exists stays honest and the copy is specific', async () => {
    const user = userEvent.setup();
    vi.spyOn(workspaceApi, 'validate').mockResolvedValue({
      status: 'validated',
      result: { ok: false, exists: true, kind: 'missing' },
    });
    setup();
    await screen.findByRole('region', { name: 'Quick Start' });

    await enterPath(user, '/bench/firmware/Makefile');
    expect(await screen.findByText('That path is a file, not a folder.')).toBeInTheDocument();
  });

  it('a stale verdict never survives a retyped path', async () => {
    const user = userEvent.setup();
    vi.spyOn(workspaceApi, 'validate').mockResolvedValue({
      status: 'validated',
      result: { ok: true, exists: true, kind: 'firmware', detectedBuild: 'make' },
    });
    setup();
    await screen.findByRole('region', { name: 'Quick Start' });

    await enterPath(user, '/bench/firmware/bme280');
    await screen.findByText(/Firmware folder found on the runner/);

    await user.type(pathInput(), '-typo');
    expect(screen.queryByText(/Firmware folder found on the runner/)).not.toBeInTheDocument();
  });
});

describe('Quick Start feature detection (the route is not contract)', () => {
  it('no /workspace/validate: no inline states, and the flow still completes on defaults', async () => {
    const user = userEvent.setup();
    // beforeEach already stubs `unsupported` — the runner has no such route.
    const { saveBoardProfile, createRun } = setup();
    await screen.findByRole('region', { name: 'Quick Start' });

    await enterPath(user, '/bench/firmware/bme280-f303re');
    await user.click(screen.getByRole('textbox', { name: 'Ask Boardex' }));
    await user.paste('bring up the BME280');

    // Nothing is claimed about the path — no green, no amber, no red.
    expect(screen.queryByText(/Firmware folder found/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not found on the runner/)).not.toBeInTheDocument();
    expect(screen.queryByText(/looks like it is in/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create Run Plan' }));
    await waitFor(() => expect(saveBoardProfile).toHaveBeenCalledTimes(1));
    expect(saveBoardProfile.mock.calls[0]?.[0]).toMatchObject({
      repoPath: '/bench/firmware/bme280-f303re',
      buildCommand: 'make', // the documented fallback
    });
    expect(createRun).toHaveBeenCalledTimes(1);
  });

  it('a probe that fails outright is silent too — we know nothing about the path', async () => {
    const user = userEvent.setup();
    vi.spyOn(workspaceApi, 'validate').mockRejectedValue(new TypeError('Failed to fetch'));
    setup();
    await screen.findByRole('region', { name: 'Quick Start' });

    await enterPath(user, '/bench/firmware/bme280-f303re');
    await waitFor(() =>
      expect(screen.queryByText('Checking the path on the runner…')).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Not found on the runner/)).not.toBeInTheDocument();
  });
});

describe('Quick Start assembly — one click, two entities', () => {
  it('compiles the profile, saves it, then creates the run against what the runner echoed', async () => {
    const user = userEvent.setup();
    vi.spyOn(workspaceApi, 'validate').mockResolvedValue({
      status: 'validated',
      result: { ok: true, exists: true, kind: 'firmware', detectedBuild: 'cmake --build' },
    });
    const { saveBoardProfile, createRun } = setup();
    await screen.findByRole('region', { name: 'Quick Start' });

    await enterPath(user, '/bench/firmware/bme280-f303re');
    await screen.findByText(/Firmware folder found on the runner/);
    await user.click(screen.getByRole('textbox', { name: 'Ask Boardex' }));
    await user.paste('Bring up the BME280 over I2C.');

    // The board name is derived from the folder, and stays editable.
    expect(screen.getByLabelText('Board name')).toHaveValue('bme280-f303re');
    await user.clear(screen.getByLabelText('Board name'));
    await user.type(screen.getByLabelText('Board name'), 'Bench board 2');

    await user.click(screen.getByRole('button', { name: 'Create Run Plan' }));

    await waitFor(() => expect(saveBoardProfile).toHaveBeenCalledTimes(1));
    const saved = saveBoardProfile.mock.calls[0]?.[0] as BoardProfile;
    expect(saved).toMatchObject({
      name: 'Bench board 2',
      repoPath: '/bench/firmware/bme280-f303re',
      buildCommand: 'cmake --build',
      mcu: 'stm32f303retx',
      flashCommand: 'pyocd flash --target stm32f303retx firmware.elf',
      instruments: { debugProbe: 'pyocd:stlink:1' },
      safety: { maxIterations: 3, flashRequiresApproval: true },
    });
    expect(saved.connectionChecklist).toHaveLength(3);

    // Then the run, against the saved profile's id — save first, always: a run
    // pointing at a profile the runner never accepted has no safety context.
    expect(createRun).toHaveBeenCalledWith({
      taskPrompt: 'Bring up the BME280 over I2C.',
      boardProfileId: saved.id,
    });
    expect(saveBoardProfile.mock.invocationCallOrder[0]).toBeLessThan(
      createRun.mock.invocationCallOrder[0] as number,
    );
  });

  it('surfaces a failed save without creating a run', async () => {
    const user = userEvent.setup();
    const { saveBoardProfile, createRun } = setup();
    saveBoardProfile.mockRejectedValue(new Error('runner unreachable'));
    await screen.findByRole('region', { name: 'Quick Start' });

    await enterPath(user, '/bench/firmware/bme280');
    await user.click(screen.getByRole('textbox', { name: 'Ask Boardex' }));
    await user.paste('bring up the BME280');
    await user.click(screen.getByRole('button', { name: 'Create Run Plan' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not save the board and create the run',
    );
    expect(createRun).not.toHaveBeenCalled();
  });

  it('needs a path before it can create anything', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('region', { name: 'Quick Start' });
    await user.click(screen.getByRole('textbox', { name: 'Ask Boardex' }));
    await user.paste('bring up the BME280');
    expect(screen.getByRole('button', { name: 'Create Run Plan' })).toBeDisabled();
  });
});

describe('Quick Start recents (settings module memory)', () => {
  it('remembers the path a run was created with', async () => {
    const user = userEvent.setup();
    const { saveBoardProfile } = setup();
    await screen.findByRole('region', { name: 'Quick Start' });

    await enterPath(user, '/bench/firmware/bme280-f303re');
    await user.click(screen.getByRole('textbox', { name: 'Ask Boardex' }));
    await user.paste('bring up the BME280');
    await user.click(screen.getByRole('button', { name: 'Create Run Plan' }));

    await waitFor(() => expect(saveBoardProfile).toHaveBeenCalled());
    await waitFor(() =>
      expect(getRecentRepoPaths()).toEqual(['/bench/firmware/bme280-f303re']),
    );
  });

  it('offers remembered paths as chips that fill and validate the field', async () => {
    const user = userEvent.setup();
    const validate = vi.spyOn(workspaceApi, 'validate').mockResolvedValue({
      status: 'validated',
      result: { ok: true, exists: true, kind: 'firmware', detectedBuild: 'make' },
    });
    addRecentRepoPath('/bench/firmware/bme280-f303re');
    setup();
    await screen.findByRole('region', { name: 'Quick Start' });

    // Chips are labelled by folder — the part a human recognises.
    await user.click(screen.getByRole('button', { name: 'bme280-f303re' }));
    expect(pathInput()).toHaveValue('/bench/firmware/bme280-f303re');
    expect(validate).toHaveBeenCalledWith('/bench/firmware/bme280-f303re');
    expect(await screen.findByText(/Firmware folder found on the runner/)).toBeInTheDocument();
  });

  it('renders no recents row before anything is remembered', async () => {
    setup();
    await screen.findByRole('region', { name: 'Quick Start' });
    expect(screen.queryByRole('list', { name: 'Recent repo paths' })).not.toBeInTheDocument();
  });
});
