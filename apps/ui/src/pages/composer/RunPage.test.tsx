// RunPage blocked state (T1.3 review finding 1): at plan_ready, the D12 gate requires
// resolved safety context. If the profiles query fails, or resolves without the run's
// boardProfileId, an explicit amber blocked card renders instead of PlanReview —
// Approve Plan is absent from the DOM, not merely disabled — and Retry refetches the
// profiles, restoring the gate on success. Run state is seeded through the real run
// store (the one derivation path, D5); only the HTTP client and stream hook are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { BenchStatus, BoardProfile, Event, Run } from '@boardex/contract';

const listBoardProfiles = vi.fn<() => Promise<BoardProfile[]>>();
const getBench = vi.fn<() => Promise<BenchStatus>>();
const approvePlan = vi.fn<() => Promise<void>>();

vi.mock('../../lib/api', () => ({
  api: {
    listBoardProfiles: () => listBoardProfiles(),
    getBench: () => getBench(),
    approvePlan: () => approvePlan(),
  },
  StateConflict: class StateConflict extends Error {},
}));
vi.mock('../../lib/useRunStream', () => ({ useRunStream: () => {} }));

import RunPage from './RunPage';
import { useRunStore } from '../../lib/runStore';
import { useBenchStore } from '../../lib/benchStore';

const TS = '2026-07-07T12:00:00.000Z';
const RUN_ID = 'run_t13_gate';

const PROFILE: BoardProfile = {
  id: 'bp_nucleo_f303re',
  name: 'Nucleo-F303RE',
  mcu: 'STM32F303RE',
  repoPath: '/bench/firmware/bme280-f303re',
  buildCommand: 'make',
  flashCommand: 'pyocd flash firmware.elf',
  resetCommand: 'pyocd reset',
  serial: { port: '/dev/ttyACM0', baud: 115200 },
  instruments: { debugProbe: 'ST-Link/V2-1 (on-board, via pyOCD)' },
  safety: { maxIterations: 3, flashRequiresApproval: true, powerNote: 'USB, 3V3 confirmed.' },
  connectionChecklist: [
    { label: 'SCL — PB8', detail: 'Nucleo PB8 to BME280 SCL' },
    { label: 'SDA — PB9', detail: 'Nucleo PB9 to BME280 SDA' },
  ],
  knownQuirks: [],
};

const BENCH: BenchStatus = {
  runnerOnline: true,
  contractVersion: 'boardex-contract/0.1',
  devices: [
    { id: 'pyocd:stlink:1', kind: 'debug_probe', name: 'ST-Link/V2-1', state: 'online' },
  ],
};

const RUN: Run = {
  id: RUN_ID,
  title: 'Bring up BME280',
  taskPrompt: 'Bring up the BME280 sensor over I2C.',
  boardProfileId: PROFILE.id,
  status: 'draft',
  createdAt: TS,
  updatedAt: TS,
  iteration: 1,
};

// Seed the run store to plan_ready with a one-step plan, exactly as the stream would.
function seedPlanReady() {
  const events: Event[] = [
    { seq: 1, runId: RUN_ID, ts: TS, type: 'run.created', payload: { run: RUN } },
    { seq: 2, runId: RUN_ID, ts: TS, type: 'run.status_changed', payload: { status: 'plan_ready' } },
    {
      seq: 3,
      runId: RUN_ID,
      ts: TS,
      type: 'run.plan_generated',
      payload: {
        plan: [
          {
            index: 0,
            title: 'Understand the task and board context',
            detail: 'Read the datasheet.',
            riskLevel: 'low',
            hardwareAction: false,
          },
        ],
        riskSummary: 'No hardware actions before approval.',
      },
    },
  ];
  useRunStore.getState().ingestMany(RUN_ID, events);
}

function renderRunPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}`]}>
        <Routes>
          <Route path="/runs/:id" element={<RunPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getBench.mockResolvedValue(BENCH);
  seedPlanReady();
});

afterEach(() => {
  vi.clearAllMocks();
  useRunStore.getState().resetAll();
  useBenchStore.getState().clear();
});

describe('RunPage profile-blocked state (fail-closed, T1.3 review finding 1)', () => {
  it('blocks approval behind the amber card when the profiles query fails, and Retry restores the gate', async () => {
    const user = userEvent.setup();
    listBoardProfiles.mockRejectedValueOnce(new Error('runner unreachable'));
    listBoardProfiles.mockResolvedValue([PROFILE]);
    renderRunPage();

    // Blocked card, with Approve Plan absent from the DOM — not merely disabled.
    expect(await screen.findByText('Board profile unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve Plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    // Retry refetches; on success the D12 gate renders normally: checklist present,
    // Approve rendered but disabled until each line is confirmed.
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    const approve = await screen.findByRole('button', { name: 'Approve Plan' });
    expect(approve).toBeDisabled();
    expect(screen.getAllByRole('checkbox')).toHaveLength(PROFILE.connectionChecklist.length);
    expect(listBoardProfiles).toHaveBeenCalledTimes(2);
  });

  it('blocks identically when profiles resolve but the run boardProfileId is not among them', async () => {
    listBoardProfiles.mockResolvedValue([{ ...PROFILE, id: 'bp_other_board' }]);
    renderRunPage();

    expect(await screen.findByText('Board profile unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve Plan' })).not.toBeInTheDocument();
  });
});
