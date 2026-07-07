// Inline bench readiness (BIBLE §7.2): all devices listed with status dots; the
// amber degraded warning appears only when a device is offline/error, and names the
// offline devices.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BenchStatus } from '@boardex/contract';
import { BenchReadiness } from './BenchReadiness';
import { offlineDevices } from './benchDevices';

function bench(logicAnalyzerState: 'online' | 'offline'): BenchStatus {
  return {
    runnerOnline: true,
    contractVersion: 'boardex-contract/0.1',
    devices: [
      { id: 'pyocd:stlink:1', kind: 'debug_probe', name: 'ST-Link/V2-1', state: 'online' },
      { id: 'serial:/dev/ttyACM0', kind: 'serial', name: 'USART2 over ST-Link VCP', state: 'online' },
      {
        id: 'sigrok:kingst-la2016:conn=3.12',
        kind: 'logic_analyzer',
        name: 'Kingst LA2016',
        state: logicAnalyzerState,
        ...(logicAnalyzerState === 'offline' ? { detail: 'Not detected by sigrok' } : {}),
      },
    ],
  };
}

describe('BenchReadiness (§7.2)', () => {
  it('lists every device and shows no warning when all are online', () => {
    render(<BenchReadiness bench={bench('online')} />);
    expect(screen.getByText('ST-Link/V2-1')).toBeInTheDocument();
    expect(screen.getByText('Kingst LA2016')).toBeInTheDocument();
    expect(screen.queryByText('Bench degraded')).not.toBeInTheDocument();
  });

  it('shows the degraded warning listing the offline device (mock runner --degraded)', () => {
    render(<BenchReadiness bench={bench('offline')} />);
    expect(screen.getByText('Bench degraded')).toBeInTheDocument();
    expect(
      screen.getByText('Kingst LA2016 — offline (Not detected by sigrok)'),
    ).toBeInTheDocument();
  });

  it('derives only non-online devices as degraded', () => {
    expect(offlineDevices(bench('online'))).toEqual([]);
    expect(offlineDevices(bench('offline')).map((d) => d.id)).toEqual([
      'sigrok:kingst-la2016:conn=3.12',
    ]);
    expect(offlineDevices(null)).toEqual([]);
  });
});
