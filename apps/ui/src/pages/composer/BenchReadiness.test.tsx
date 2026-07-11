// Inline bench readiness (BIBLE §7.2): all devices listed with status dots, and the
// amber warning that distinguishes a device the bench reports unhealthy from a profile
// reference the bench has never heard of.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BenchStatus, BoardProfile } from '@boardex/contract';
import { BenchReadiness } from './BenchReadiness';

const LA_ID = 'sigrok:kingst-la2016:conn=3.12';
const PROBE_ID = 'pyocd:stlink:1';

function bench(logicAnalyzerState: 'online' | 'offline'): BenchStatus {
  return {
    runnerOnline: true,
    contractVersion: 'boardex-contract/0.1',
    devices: [
      { id: PROBE_ID, kind: 'debug_probe', name: 'ST-Link/V2-1', state: 'online' },
      { id: 'serial:/dev/ttyACM0', kind: 'serial', name: 'USART2 over ST-Link VCP', state: 'online' },
      {
        id: LA_ID,
        kind: 'logic_analyzer',
        name: 'Kingst LA2016',
        state: logicAnalyzerState,
        ...(logicAnalyzerState === 'offline' ? { detail: 'Not detected by sigrok' } : {}),
      },
    ],
  };
}

const instruments: BoardProfile['instruments'] = {
  debugProbe: PROBE_ID,
  logicAnalyzer: LA_ID,
};

describe('BenchReadiness (§7.2)', () => {
  it('lists every device and shows no warning when all are online and resolve', () => {
    render(<BenchReadiness bench={bench('online')} instruments={instruments} />);
    expect(screen.getByText('ST-Link/V2-1')).toBeInTheDocument();
    expect(screen.getByText('Kingst LA2016')).toBeInTheDocument();
    expect(screen.queryByText('Bench degraded')).not.toBeInTheDocument();
  });

  it('warns that a matched device is offline, not that it is unknown (mock --degraded)', () => {
    render(<BenchReadiness bench={bench('offline')} instruments={instruments} />);
    expect(screen.getByText('Bench degraded')).toBeInTheDocument();
    expect(
      screen.getByText('Kingst LA2016 is on the bench but offline (Not detected by sigrok)'),
    ).toBeInTheDocument();
  });

  it('warns that an unmatched reference is unknown, not that it is offline', () => {
    render(
      <BenchReadiness
        bench={bench('online')}
        instruments={{ debugProbe: PROBE_ID, logicAnalyzer: 'Saleae Logic 8' }}
      />,
    );
    expect(screen.getByText('Bench references not found')).toBeInTheDocument();
    const row = screen.getByText('Saleae Logic 8 was not found on the bench');
    expect(screen.queryByText(/is on the bench but/)).not.toBeInTheDocument();

    // F3: no dot of any state — a reference nothing answers to has no device whose
    // health a dot could report. The union in benchReadiness makes the data impossible;
    // this pins the rendering.
    expect(row.closest('li')?.querySelector('.bg-pass, .bg-warn, .bg-fail')).toBeNull();
  });

  it('distinguishes the two in one list when both are true', () => {
    render(
      <BenchReadiness
        bench={bench('offline')}
        instruments={{ debugProbe: 'J-Link EDU', logicAnalyzer: LA_ID }}
      />,
    );
    // A real device is unhealthy, so the bench itself is degraded — and the profile
    // separately names a probe nothing answers to.
    expect(screen.getByText('Bench degraded')).toBeInTheDocument();
    expect(screen.getByText(/Kingst LA2016 is on the bench but offline/)).toBeInTheDocument();
    expect(screen.getByText('J-Link EDU was not found on the bench')).toBeInTheDocument();
  });

  it('renders without a profile: bench facts only', () => {
    render(<BenchReadiness bench={bench('offline')} instruments={null} />);
    expect(screen.getByText(/Kingst LA2016 is on the bench but offline/)).toBeInTheDocument();
  });

  it('says so when there is no bench snapshot at all', () => {
    render(<BenchReadiness bench={null} instruments={instruments} />);
    expect(screen.getByText('Bench status unavailable.')).toBeInTheDocument();
  });
});
