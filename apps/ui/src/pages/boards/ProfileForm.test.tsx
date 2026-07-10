// The Board Profile Builder form (BIBLE §7.5): contract-schema validation surfacing as
// inline field errors, checklist add/remove/reorder, Validate Profile against the live
// bench (found / degraded / missing), and Save → POST /board-profiles.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BenchStatusSchema,
  BoardProfileSchema,
  type BenchStatus,
  type BoardProfile,
} from '@boardex/contract';

const getBench = vi.fn<() => Promise<BenchStatus>>();
const saveBoardProfile = vi.fn<(profile: BoardProfile) => Promise<BoardProfile>>();

vi.mock('../../lib/api', () => ({
  api: {
    getBench: () => getBench(),
    saveBoardProfile: (profile: BoardProfile) => saveBoardProfile(profile),
  },
}));

import { ProfileForm } from './ProfileForm';
import { blankDraft, fromProfile } from './profileDraft';

const PROBE_ID = 'pyocd:stlink:066EFF383733554157254923';
const LA_ID = 'sigrok:kingst-la2016:conn=3.12';

const PROFILE: BoardProfile = BoardProfileSchema.parse({
  id: 'bp_test',
  name: 'Nucleo-F303RE',
  mcu: 'STM32F303RE (Cortex-M4)',
  repoPath: '/bench/firmware/bme280-f303re',
  buildCommand: 'make clean && make',
  flashCommand: 'pyocd flash --target stm32f303retx bme280.elf',
  resetCommand: 'pyocd reset --target stm32f303retx',
  serial: { port: '/dev/ttyACM0', baud: 115200 },
  instruments: { debugProbe: PROBE_ID, logicAnalyzer: LA_ID },
  safety: { maxIterations: 3, flashRequiresApproval: true, powerNote: '3V3 confirmed.' },
  connectionChecklist: [
    { label: 'SCL — PB8', detail: 'PB8 to BME280 SCL' },
    { label: 'SDA — PB9', detail: 'PB9 to BME280 SDA' },
    { label: 'GND', detail: 'GND to GND' },
  ],
  knownQuirks: ['BMP280 clones report chip id 0x58.'],
});

function bench(laState: 'online' | 'offline' | 'error' = 'online'): BenchStatus {
  return BenchStatusSchema.parse({
    runnerOnline: true,
    contractVersion: 'boardex-contract/0.1',
    devices: [
      { id: PROBE_ID, kind: 'debug_probe', name: 'ST-Link/V2-1 (NUCLEO-F303RE)', state: 'online' },
      { id: LA_ID, kind: 'logic_analyzer', name: 'Kingst LA2016', state: laState },
    ],
  });
}

function renderForm(mode: 'new' | 'edit' = 'edit', onSaved = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const initial = mode === 'new' ? blankDraft('bp_new') : fromProfile(PROFILE);
  render(
    <QueryClientProvider client={client}>
      <ProfileForm mode={mode} initial={initial} onSaved={onSaved} />
    </QueryClientProvider>,
  );
  return { onSaved };
}

const rows = () => screen.getAllByRole('listitem', { name: /^Connection \d+$/ });
const rowLabels = () =>
  rows().map((row) => (within(row).getByLabelText('Label') as HTMLInputElement).value);

beforeEach(() => {
  getBench.mockResolvedValue(bench());
  saveBoardProfile.mockImplementation((profile) => Promise.resolve(profile));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('validation against the contract schema', () => {
  it('blocks the save and marks every required field, section by section', async () => {
    const user = userEvent.setup();
    renderForm('new');

    await user.click(screen.getByRole('button', { name: 'Create Profile' }));

    expect(saveBoardProfile).not.toHaveBeenCalled();
    // Identity · Firmware ×4 · Serial port · Instruments probe · Safety power note.
    expect(screen.getAllByText('Required.')).toHaveLength(9);
    for (const label of ['Name', 'MCU', 'Repo path', 'Build command', 'Debug probe']) {
      expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true');
    }
    // The two numeric fields get their own message, not "Required."
    expect(screen.getByLabelText('Baud')).toHaveAccessibleDescription(/whole number/);
    expect(screen.getByLabelText('Max iterations')).toHaveAccessibleDescription(/whole number/);
    expect(screen.getByRole('alert')).toHaveTextContent('11 fields need attention');
  });

  it('errors a checklist row that is half-filled, at that row', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(within(rows()[1] as HTMLElement).getByLabelText('Detail'));
    await user.click(screen.getByRole('button', { name: 'Save Profile' }));

    expect(saveBoardProfile).not.toHaveBeenCalled();
    expect(within(rows()[1] as HTMLElement).getByText('Required.')).toBeInTheDocument();
    expect(within(rows()[0] as HTMLElement).queryByText('Required.')).not.toBeInTheDocument();
  });

  it('POSTs the contract-valid profile and reports the runner’s echo back', async () => {
    const user = userEvent.setup();
    const { onSaved } = renderForm();

    await user.click(screen.getByRole('button', { name: 'Save Profile' }));

    expect(saveBoardProfile).toHaveBeenCalledWith(PROFILE);
    expect(onSaved).toHaveBeenCalledWith(PROFILE);
  });

  it('surfaces a failed save with the house alert and keeps the draft on screen', async () => {
    const user = userEvent.setup();
    saveBoardProfile.mockRejectedValue(new TypeError('Failed to fetch'));
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Save Profile' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not save the profile/);
    expect(screen.getByLabelText('Name')).toHaveValue('Nucleo-F303RE');
  });
});

describe('connection checklist rows (D12)', () => {
  it('adds a blank row at the end', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Add connection' }));

    expect(rowLabels()).toEqual(['SCL — PB8', 'SDA — PB9', 'GND', '']);
  });

  it('removes exactly the row it is asked to remove', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(within(rows()[1] as HTMLElement).getByRole('button', { name: 'Remove' }));
    expect(rowLabels()).toEqual(['SCL — PB8', 'GND']);
  });

  it('reorders rows, and saves the checklist in its new order', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(within(rows()[2] as HTMLElement).getByRole('button', { name: 'Move up' }));
    expect(rowLabels()).toEqual(['SCL — PB8', 'GND', 'SDA — PB9']);

    await user.click(within(rows()[0] as HTMLElement).getByRole('button', { name: 'Move down' }));
    expect(rowLabels()).toEqual(['GND', 'SCL — PB8', 'SDA — PB9']);

    await user.click(within(rows()[1] as HTMLElement).getByRole('button', { name: 'Remove' }));
    expect(rowLabels()).toEqual(['GND', 'SDA — PB9']);

    // Full equality, not objectContaining: reordering rows must change the checklist
    // and nothing else — no dropped knownQuirks, no rewritten commands (review F5).
    await user.click(screen.getByRole('button', { name: 'Save Profile' }));
    expect(saveBoardProfile).toHaveBeenCalledWith({
      ...PROFILE,
      connectionChecklist: [
        { label: 'GND', detail: 'GND to GND' },
        { label: 'SDA — PB9', detail: 'PB9 to BME280 SDA' },
      ],
    });
  });

  it('cannot move the first row up or the last row down', () => {
    renderForm();
    const list = rows();
    expect(within(list[0] as HTMLElement).getByRole('button', { name: 'Move up' })).toBeDisabled();
    expect(
      within(list[2] as HTMLElement).getByRole('button', { name: 'Move down' }),
    ).toBeDisabled();
  });
});

describe('Validate Profile against the bench (§7.5)', () => {
  it('marks a device-id reference found, with its stable id', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Validate Profile' }));

    const panel = await screen.findByRole('status', { name: 'Bench validation' });
    expect(panel).toHaveTextContent('Validated — every referenced instrument is on the bench');
    expect(within(panel).getByText(PROBE_ID)).toBeInTheDocument();
    expect(within(panel).getByText(LA_ID)).toBeInTheDocument();
  });

  it('marks an unmatched reference missing, naming what failed to match — and still allows saving', async () => {
    const user = userEvent.setup();
    renderForm();

    const probe = screen.getByLabelText('Debug probe');
    await user.clear(probe);
    await user.type(probe, 'J-Link EDU');
    await user.click(screen.getByRole('button', { name: 'Validate Profile' }));

    const panel = await screen.findByRole('status', { name: 'Bench validation' });
    expect(panel).toHaveTextContent('Validated with warnings');
    expect(panel).toHaveTextContent('J-Link EDU was not found on the bench');
    // F3: the missing row carries no StatusDot — nothing there has a state to report.
    const missingRow = within(panel).getByText('J-Link EDU was not found on the bench');
    expect(missingRow.closest('li')?.querySelector('.bg-pass, .bg-warn, .bg-fail')).toBeNull();

    // Advisory, not blocking: benches change (§7.5).
    await user.click(screen.getByRole('button', { name: 'Save Profile' }));
    expect(saveBoardProfile).toHaveBeenCalledWith(
      expect.objectContaining({ instruments: { debugProbe: 'J-Link EDU', logicAnalyzer: LA_ID } }),
    );
  });

  // The T4.2 seam: "on the bench but offline" (unplug it, plug it back in) must never
  // read like "was not found on the bench" (fix the reference in this form).
  it.each([
    ['offline', 'Kingst LA2016 is on the bench but offline'],
    ['error', 'Kingst LA2016 is on the bench but in error'],
  ] as const)('marks a matched but %s device degraded, distinctly from missing', async (state, text) => {
    const user = userEvent.setup();
    getBench.mockResolvedValue(bench(state));
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Validate Profile' }));

    const panel = await screen.findByRole('status', { name: 'Bench validation' });
    expect(panel).toHaveTextContent('Validated with warnings');
    expect(panel).toHaveTextContent(text);
    expect(panel).not.toHaveTextContent('was not found on the bench');
    expect(within(panel).getByText(LA_ID)).toBeInTheDocument();
  });

  it('re-reads the bench on every click rather than trusting the picker’s snapshot', async () => {
    const user = userEvent.setup();
    renderForm();
    await screen.findAllByRole('option', { name: /ST-Link/ });
    const afterMount = getBench.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Validate Profile' }));
    await screen.findByRole('status', { name: 'Bench validation' });

    expect(getBench.mock.calls.length).toBeGreaterThan(afterMount);
  });

  it('drops a stale result the moment an instrument field is edited', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Validate Profile' }));
    await screen.findByRole('status', { name: 'Bench validation' });

    await user.type(screen.getByLabelText('Debug probe'), 'x');
    expect(screen.queryByRole('status', { name: 'Bench validation' })).not.toBeInTheDocument();
  });

  it('warns instead of guessing when the bench cannot be read', async () => {
    const user = userEvent.setup();
    getBench.mockRejectedValue(new TypeError('Failed to fetch'));
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Validate Profile' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach the runner/);
    expect(screen.queryByRole('status', { name: 'Bench validation' })).not.toBeInTheDocument();
  });
});

describe('detected-device picker', () => {
  it('writes the device’s stable id into the free-text field', async () => {
    const user = userEvent.setup();
    renderForm('new');

    // The picker fills in once GET /bench answers; until then it offers nothing.
    await screen.findByRole('option', { name: /ST-Link/ });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Detected debug probes' }),
      PROBE_ID,
    );

    expect(screen.getByLabelText('Debug probe')).toHaveValue(PROBE_ID);
  });

  it('offers only devices of that instrument’s kind', async () => {
    renderForm('new');
    await screen.findByRole('option', { name: /ST-Link/ });

    const probes = screen.getByRole('combobox', { name: 'Detected debug probes' });
    expect(within(probes).getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual([
      '',
      PROBE_ID,
    ]);
    const analyzers = screen.getByRole('combobox', { name: 'Detected logic analyzers' });
    expect(within(analyzers).getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual([
      '',
      LA_ID,
    ]);
  });
});
