// Model selection feature-detection (BIBLE §7.2 / T6.3 / T6.6): the composer's model
// picker is driven entirely by GET /health.capabilities.models — never assumed. It
// appears only when the runner advertises MORE THAN ONE model; with one or none there
// is nothing to choose, so no UI and no model rides along on POST /runs. The api seam
// is stubbed; the live end-to-end path is the composer integration test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { BenchStatus, BoardProfile, HealthResponse } from '@boardex/contract';
import { api } from '../../lib/api';
import NewRunPage from './NewRunPage';

const profile: BoardProfile = {
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

const bench: BenchStatus = { runnerOnline: true, contractVersion: 'boardex-contract/0.1', devices: [] };

function setup(capabilities: HealthResponse['capabilities']) {
  vi.spyOn(api, 'listBoardProfiles').mockResolvedValue([profile]);
  vi.spyOn(api, 'getBench').mockResolvedValue(bench);
  const health: HealthResponse = {
    ok: true,
    contractVersion: 'boardex-contract/0.1',
    runnerKind: 'mock',
    ...(capabilities ? { capabilities } : {}),
  };
  vi.spyOn(api, 'getHealth').mockResolvedValue(health);
  const createRun = vi.spyOn(api, 'createRun').mockResolvedValue({ runId: 'run_new' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs/new']}>
        <NewRunPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { createRun };
}

afterEach(() => vi.restoreAllMocks());

const modelSelect = () => screen.queryByRole('combobox', { name: 'Model' });

describe('composer model selection (feature-detected, T6.3)', () => {
  it('present (>1 model): renders a select defaulting to the first, and rides it on POST /runs', async () => {
    const user = userEvent.setup();
    const { createRun } = setup({ models: ['mock-model', 'mock-model-pro'] });

    const select = await screen.findByRole('combobox', { name: 'Model' });
    expect(select).toHaveValue('mock-model'); // default = first

    await user.type(screen.getByRole('textbox', { name: 'Ask Boardex' }), 'bring up BME280');
    await user.selectOptions(select, 'mock-model-pro');
    await user.click(screen.getByRole('button', { name: 'Create Run Plan' }));

    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({ boardProfileId: 'bp_nucleo_f303re', model: 'mock-model-pro' }),
    );
  });

  it('single model: no select, and no model rides along', async () => {
    const user = userEvent.setup();
    const { createRun } = setup({ models: ['mock-model'] });
    // Wait for health + profiles to settle (the profile option appears).
    await screen.findByRole('option', { name: 'Nucleo-F303RE' });
    expect(modelSelect()).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Ask Boardex' }), 'bring up BME280');
    await user.click(screen.getByRole('button', { name: 'Create Run Plan' }));
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(createRun.mock.calls[0]?.[0]).not.toHaveProperty('model');
  });

  it('absent capabilities: no select (feature-detected, never assumed)', async () => {
    setup(undefined);
    await screen.findByRole('option', { name: 'Nucleo-F303RE' });
    expect(modelSelect()).not.toBeInTheDocument();
  });
});
