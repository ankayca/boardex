// D12 REGRESSION PIN — the plan gate on a Quick Start run.
//
// Quick Start compiles a board profile instead of asking a human to type one. The one
// thing that must NOT change with it is the safety gate: a run against a compiled
// profile reaches the plan gate with a real connection checklist, every line unchecked,
// and Approve Plan disabled until a human confirms each one by hand. Nothing here
// auto-confirms, and PlanReview itself is untouched by Quick Start.
//
// This is the REAL pin, not the mock-replay one: the profile under test is built by
// buildQuickStartProfile, exactly as the composer builds it, so it fails if the seeded
// checklist is ever emptied, shortened, or pre-confirmed.
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
import { buildQuickStartProfile, QUICK_START_CHECKLIST } from './quickStartProfile';

const TS = '2026-07-28T12:00:00.000Z';
const RUN_ID = 'run_quickstart_gate';

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

// The profile the composer would have compiled and POSTed for this run.
const QUICK_PROFILE: BoardProfile = buildQuickStartProfile(
  {
    repoPath: '/bench/firmware/bme280-f303re',
    name: 'bme280-f303re',
    detectedBuild: 'make',
    bench: BENCH,
  },
  'bp_quickstart_gate',
);

const RUN: Run = {
  id: RUN_ID,
  title: 'Bring up BME280',
  taskPrompt: 'Bring up the BME280 sensor over I2C.',
  boardProfileId: QUICK_PROFILE.id,
  status: 'draft',
  createdAt: TS,
  updatedAt: TS,
  iteration: 1,
};

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
            title: 'Flash the firmware',
            detail: 'Write the built image to the target.',
            riskLevel: 'medium',
            hardwareAction: true,
          },
        ],
        riskSummary: 'One hardware action: flashing the target.',
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
  listBoardProfiles.mockResolvedValue([QUICK_PROFILE]);
  seedPlanReady();
});

afterEach(() => {
  vi.clearAllMocks();
  useRunStore.getState().resetAll();
  useBenchStore.getState().clear();
});

describe('D12 at the plan gate — unchanged on a Quick Start run', () => {
  it('renders the compiled checklist unchecked and gates Approve Plan behind every line', async () => {
    const user = userEvent.setup();
    renderRunPage();

    const approve = await screen.findByRole('button', { name: /approve plan/i });

    // The gate exists, with one row per seeded precondition — never auto-checked.
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(QUICK_START_CHECKLIST.length);
    expect(boxes).toHaveLength(3);
    for (const box of boxes) expect(box).not.toBeChecked();
    for (const row of QUICK_START_CHECKLIST) {
      expect(screen.getByText(row.label)).toBeInTheDocument();
    }
    expect(approve).toBeDisabled();

    // Partial confirmation is not confirmation.
    await user.click(boxes[0] as HTMLElement);
    await user.click(boxes[1] as HTMLElement);
    expect(approve).toBeDisabled();
    expect(approvePlan).not.toHaveBeenCalled();

    // Only a human confirming every line opens it.
    await user.click(boxes[2] as HTMLElement);
    expect(approve).toBeEnabled();
    await user.click(approve);
    expect(approvePlan).toHaveBeenCalledTimes(1);
  });

  it('names the seeded rows as universal preconditions, never board-specific wiring', () => {
    // The 2026-07-28 ruling in one assertion: Quick Start may ask about power, probe
    // and cable — it may not claim to know which pin is SCL.
    expect(QUICK_PROFILE.connectionChecklist.map((row) => row.label)).toEqual([
      'Board powered (3V3/5V confirmed)',
      'Debug probe connected',
      'Serial cable connected',
    ]);
  });
});
