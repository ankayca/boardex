// The composer's credentials pre-flight (§7.2): an ADVISORY amber notice when the
// runner reports the selected model's provider unconfigured, a link into Settings that
// brings the draft back, and — the point of the ruling — a Create Run Plan button that
// stays enabled throughout. Both api seams are spied; the routes themselves are
// mock-prototyped (§10.5) and pinned over HTTP in the mock runner's own suite.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { BenchStatus, BoardProfile, HealthResponse } from '@boardex/contract';
import { api } from '../../lib/api';
import { credentialsApi, type CredentialsCapability } from '../../lib/credentials';
import { resetSettingsMemory } from '../../lib/settings';
import SettingsPage from '../settings/SettingsPage';
import NewRunPage from './NewRunPage';

const AGENT_MODEL = 'openrouter/anthropic/claude-sonnet-4.6';

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

const bench: BenchStatus = {
  runnerOnline: true,
  contractVersion: 'boardex-contract/0.1',
  devices: [],
};

function setup(models: string[], capability: CredentialsCapability) {
  vi.spyOn(api, 'listBoardProfiles').mockResolvedValue([profile]);
  vi.spyOn(api, 'getBench').mockResolvedValue(bench);
  const health: HealthResponse = {
    ok: true,
    contractVersion: 'boardex-contract/0.1',
    runnerKind: 'mock',
    capabilities: { models },
  };
  vi.spyOn(api, 'getHealth').mockResolvedValue(health);
  vi.spyOn(api, 'createRun').mockResolvedValue({ runId: 'run_new' });
  vi.spyOn(credentialsApi, 'fetchCapability').mockResolvedValue(capability);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs/new']}>
        <Routes>
          <Route path="/runs/new" element={<NewRunPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const unconfigured: CredentialsCapability = {
  status: 'advertised',
  providers: [{ provider: 'openrouter', configured: false }],
};
const configured: CredentialsCapability = {
  status: 'advertised',
  providers: [{ provider: 'openrouter', configured: true, hint: '…92a4' }],
};

const notice = () => screen.queryByText(/No API key configured for/);
const composerReady = () => screen.findByRole('option', { name: 'Nucleo-F303RE' });

afterEach(() => {
  resetSettingsMemory();
  vi.restoreAllMocks();
});

describe('composer credentials pre-flight', () => {
  it('warns in amber when the selected model’s provider has no key — and never blocks', async () => {
    const user = userEvent.setup();
    setup([AGENT_MODEL], unconfigured);

    const warning = await screen.findByText(/No API key configured for/);
    expect(warning).toHaveTextContent('openrouter');
    expect(warning).toHaveTextContent('the agent needs one to run');
    // D14: amber warning, never red — a missing key is a config problem, not a failure.
    expect(warning.className).toContain('text-warn');
    expect(warning.className).not.toContain('text-fail');

    // ADVISORY, not a gate: the runner may hold a key in its environment without
    // advertising it, so the primary action stays available (§7.2 ruling).
    await user.type(screen.getByRole('textbox', { name: 'Ask Boardex' }), 'bring up BME280');
    expect(screen.getByRole('button', { name: 'Create Run Plan' })).toBeEnabled();
  });

  it('says nothing once that provider is configured', async () => {
    setup([AGENT_MODEL], configured);
    await composerReady();
    await waitFor(() => expect(credentialsApi.fetchCapability).toHaveBeenCalled());
    expect(notice()).not.toBeInTheDocument();
  });

  it('says nothing when the runner advertises no credential capability', async () => {
    setup([AGENT_MODEL], { status: 'unsupported' });
    await composerReady();
    await waitFor(() => expect(credentialsApi.fetchCapability).toHaveBeenCalled());
    expect(notice()).not.toBeInTheDocument();
  });

  it('says nothing for a model whose provider it cannot derive', async () => {
    // 'mock-model' carries no provider prefix. The runner resolves such names with
    // tables the browser does not have, so an unconfigured openrouter says nothing
    // about THIS model — silence is the honest answer, not a warning.
    setup(['mock-model'], unconfigured);
    await composerReady();
    await waitFor(() => expect(credentialsApi.fetchCapability).toHaveBeenCalled());
    expect(notice()).not.toBeInTheDocument();
  });

  it('follows the selected model when more than one is advertised', async () => {
    const user = userEvent.setup();
    setup(['mock-model', AGENT_MODEL], unconfigured);
    await composerReady();
    // Default is the first model, which derives no provider: no notice.
    expect(notice()).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), AGENT_MODEL);
    expect(await screen.findByText(/No API key configured for/)).toBeInTheDocument();
  });

  it('carries the draft task to Settings and back — the round trip costs nothing', async () => {
    const user = userEvent.setup();
    setup([AGENT_MODEL], unconfigured);
    await screen.findByText(/No API key configured for/);

    const draft = 'Bring up the BMP180 over I2C and verify the chip id';
    await user.type(screen.getByRole('textbox', { name: 'Ask Boardex' }), draft);

    await user.click(screen.getByRole('link', { name: 'Add it in Settings →' }));

    // Settings, with the Model provider section the link exists to reach.
    expect(await screen.findByRole('heading', { name: 'Model provider' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Ask Boardex' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '← Back to your task' }));

    expect(await screen.findByRole('textbox', { name: 'Ask Boardex' })).toHaveValue(draft);
  });
});
