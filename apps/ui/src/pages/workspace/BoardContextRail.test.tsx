// Board Context rail instrument list (BIBLE §7.3): the three bench-readiness states,
// resolved by reference through lib/benchReadiness (T4.2, product-owner ruling). During a
// run this rail is what the operator watches, so "the analyzer is unplugged" and "this
// profile names an analyzer that does not exist" must not render the same.
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BenchStatus, BoardProfile } from '@boardex/contract';
import { BoardContextRail } from './BoardContextRail';

const PROBE_ID = 'pyocd:stlink:066EFF383733554157254923';
const LA_ID = 'sigrok:kingst-la2016:conn=3.12';
const PROBE_NAME = 'ST-Link/V2-1 (NUCLEO-F303RE)';
const LA_NAME = 'Kingst LA2016';

function bench(laState: 'online' | 'offline' | 'error' = 'online'): BenchStatus {
  return {
    runnerOnline: true,
    contractVersion: 'boardex-contract/0.1',
    devices: [
      { id: PROBE_ID, kind: 'debug_probe', name: 'ST-Link/V2-1 (NUCLEO-F303RE)', state: 'online' },
      { id: 'serial:/dev/ttyACM0', kind: 'serial', name: 'USART2 over ST-Link VCP', state: 'online' },
      { id: LA_ID, kind: 'logic_analyzer', name: 'Kingst LA2016', state: laState },
    ],
  };
}

function profile(over: Partial<BoardProfile['instruments']> = {}): BoardProfile {
  return {
    id: 'bp_nucleo_f303re',
    name: 'Nucleo-F303RE',
    mcu: 'STM32F303RE (Cortex-M4)',
    repoPath: '/bench/firmware/bme280-f303re',
    buildCommand: 'make',
    flashCommand: 'pyocd flash',
    resetCommand: 'pyocd reset',
    serial: { port: '/dev/ttyACM0', baud: 115200 },
    instruments: { debugProbe: PROBE_ID, logicAnalyzer: LA_ID, ...over },
    safety: { maxIterations: 3, flashRequiresApproval: true, powerNote: '3V3 confirmed.' },
    connectionChecklist: [],
    knownQuirks: [],
  };
}

function renderRail(over: { profile?: BoardProfile; bench?: BenchStatus | null } = {}) {
  render(
    <BoardContextRail
      profile={over.profile ?? profile()}
      profileLoading={false}
      bench={over.bench === undefined ? bench() : over.bench}
      boardProfileId="bp_nucleo_f303re"
    />,
  );
  return screen.getByRole('list', { name: 'Instruments' });
}

/** The dot's state is screen-reader-only text when the row carries a visible label. */
function rowState(row: HTMLElement): string | null {
  return row.querySelector('.sr-only')?.textContent ?? null;
}

describe('BoardContextRail instruments (§7.3, three states)', () => {
  it('found: a resolved online instrument shows a green dot labelled with the device name', () => {
    const list = renderRail();
    const probe = within(list).getByText(PROBE_NAME).closest('li') as HTMLElement;
    expect(probe.querySelector('.bg-pass')).not.toBeNull();
    // F4: the human name, not the registry id — that lives in the details drawer.
    expect(within(list).queryByText(PROBE_ID)).not.toBeInTheDocument();
  });

  it.each([
    ['offline', 'bg-warn'],
    ['error', 'bg-fail'],
  ] as const)('degraded: a matched but %s device keeps its own StatusDot', (state, dotClass) => {
    const list = renderRail({ bench: bench(state) });
    const la = within(list).getByText(LA_NAME).closest('li') as HTMLElement;
    expect(la.querySelector(`.${dotClass}`)).not.toBeNull();
    expect(rowState(la)).toBeNull(); // labelled row: the dot's state is not spelled out
    expect(within(list).queryByText(/was not found on the bench/)).not.toBeInTheDocument();
  });

  it('the stable ids the rows resolved to live in the details drawer (F4)', async () => {
    const user = userEvent.setup();
    renderRail();
    await user.click(screen.getByRole('button', { name: 'View details' }));

    const ids = screen.getByRole('region', { name: 'Instrument ids' });
    expect(within(ids).getByText(PROBE_ID)).toBeInTheDocument();
    expect(within(ids).getByText(LA_ID)).toBeInTheDocument();
  });

  it('missing: a reference the bench does not answer to has no dot and reads amber', () => {
    const list = renderRail({ profile: profile({ logicAnalyzer: 'Saleae Logic 8' }) });
    const row = within(list).getByText('Saleae Logic 8 was not found on the bench');
    expect(row).toHaveClass('text-warn');

    // No dot of any state — there is no device whose health it could report.
    const li = row.closest('li') as HTMLElement;
    expect(li.querySelector('.bg-pass, .bg-warn, .bg-fail')).toBeNull();
  });

  // The distinction this ruling exists for.
  it('an unplugged analyzer never renders like one the bench has never heard of', () => {
    const unplugged = renderRail({ bench: bench('offline') });
    const unpluggedRow = within(unplugged).getByText(LA_NAME).closest('li') as HTMLElement;
    expect(unpluggedRow.querySelector('.bg-warn')).not.toBeNull();
    expect(unpluggedRow.textContent).not.toMatch(/not found on the bench/);

    cleanup();

    const unknown = renderRail({ profile: profile({ logicAnalyzer: 'Saleae Logic 8' }) });
    expect(within(unknown).getByText(/not found on the bench/)).toBeInTheDocument();
  });

  it('serial resolves by kind, not by reference — it is a port + baud, not a named device', () => {
    const list = renderRail();
    const serial = within(list).getByText('/dev/ttyACM0 @ 115200').closest('li') as HTMLElement;
    expect(serial.querySelector('.bg-pass')).not.toBeNull();
  });

  // F5 supersedes "never an assumed online" with "never an assumed anything": an
  // unreadable bench used to paint every instrument amber, reporting a healthy analyzer
  // as unplugged whenever the socket blinked.
  it('with no bench snapshot the instruments are unknown: no dots, plain names', () => {
    const list = renderRail({ bench: null });

    expect(within(list).getByText(PROBE_ID)).toBeInTheDocument(); // the profile's own claim
    expect(list.querySelector('.bg-pass, .bg-warn, .bg-fail')).toBeNull();
    expect(within(list).queryByText(/was not found on the bench/)).not.toBeInTheDocument();
    expect(screen.getByText('Bench status unavailable.')).toBeInTheDocument();
  });

  it('a readable bench with no serial device says so rather than assuming offline', () => {
    const noSerial = bench();
    noSerial.devices = noSerial.devices.filter((d) => d.kind !== 'serial');
    const list = renderRail({ bench: noSerial });
    expect(
      within(list).getByText('/dev/ttyACM0 @ 115200 was not found on the bench'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Bench status unavailable.')).not.toBeInTheDocument();
  });

  it('an unset logic analyzer is not claimed, so it gets no row at all', () => {
    const list = renderRail({ profile: profile({ logicAnalyzer: '  ' }) });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });
});
