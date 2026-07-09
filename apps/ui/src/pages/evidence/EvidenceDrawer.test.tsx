// Evidence Detail drawer (§7.4, T3.1): deep-link routing per artifact kind at the
// component level, the two live tabs, and the T3.2 tabs rendered disabled with
// their tooltip. Views come from the real reduceRun (D5); artifact content is
// stubbed at the api seam — transport is covered by the integration test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Event, MeasurementCheck, RunView } from '@boardex/contract';
import { reduceRun } from '@boardex/contract';
import { api } from '../../lib/api';
import { artifactOf, envelope, run, RUN_ID } from '../workspace/test-events';
import { EvidenceDrawer } from './EvidenceDrawer';

const DECODE_JSON = JSON.stringify({
  protocol: 'i2c',
  sample_rate_hz: 4_000_000,
  annotations: [
    { start_sample: 812000, end_sample: 812010, text: 'START' },
    { start_sample: 812010, end_sample: 812370, text: 'ADDRESS WRITE: 76 NACK' },
    { start_sample: 812370, end_sample: 812380, text: 'STOP' },
  ],
  transactions: [{ addr_7bit: 59, rw: 'w', write: [], read: [], nack_at: 'address' }],
});

const ackCheck: MeasurementCheck = {
  id: 'chk_ack',
  runId: RUN_ID,
  requirementId: 'device_ack',
  description: 'BME280 must ACK its 7-bit address 0x76',
  measurement: 'logic_analyzer.i2c.device_ack',
  expected: { equals: true },
  actual: { value: false },
  verdict: 'fail',
  artifactId: 'art_decode',
};

const clockCheck: MeasurementCheck = {
  id: 'chk_clock',
  runId: RUN_ID,
  requirementId: 'i2c_clock',
  description: 'I2C SCL clock must be 100 kHz ±10%',
  measurement: 'logic_analyzer.i2c.scl_frequency',
  expected: { min: 90000, max: 110000 },
  actual: { value: 99600, unit: 'Hz' },
  verdict: 'pass',
  artifactId: 'art_timing',
};

function buildView(): RunView {
  const stream: Event[] = [
    envelope(1, 'run.created', { run }),
    envelope(2, 'artifact.created', { artifact: artifactOf('art_decode', 'protocol_decode') }),
    envelope(3, 'artifact.created', { artifact: artifactOf('art_timing', 'timing_measurement') }),
    envelope(4, 'check.evaluated', { check: ackCheck }),
    envelope(5, 'check.evaluated', { check: clockCheck }),
  ];
  return reduceRun(stream);
}

function renderDrawer(search: string) {
  vi.spyOn(api, 'getArtifactText').mockResolvedValue(DECODE_JSON);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}/evidence${search}`]}>
        <EvidenceDrawer view={buildView()} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

const tab = (name: string) => screen.getByRole('tab', { name });

describe('EvidenceDrawer tabs', () => {
  it('defaults to Checks and renders the T3.2 tabs disabled with the tooltip', () => {
    renderDrawer('');
    expect(tab('Checks')).toHaveAttribute('aria-selected', 'true');
    for (const name of ['Logs', 'Code Diff', 'Raw artifacts']) {
      const t32Tab = tab(name);
      expect(t32Tab).toHaveAttribute('aria-disabled', 'true');
      expect(t32Tab).toHaveAttribute('title', 'Arrives with T3.2');
    }
    expect(screen.getByRole('table', { name: 'Measurement checks' })).toBeInTheDocument();
  });

  it('ignores clicks on disabled tabs', async () => {
    const user = userEvent.setup();
    renderDrawer('');
    await user.click(tab('Logs'));
    expect(tab('Checks')).toHaveAttribute('aria-selected', 'true');
  });

  it('switches to Protocol Decode by hand, rendering the latest decode', async () => {
    const user = userEvent.setup();
    renderDrawer('');
    await user.click(tab('Protocol Decode'));
    expect(tab('Protocol Decode')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('table', { name: 'Decoded transactions' })).toBeInTheDocument();
    expect(api.getArtifactText).toHaveBeenCalledWith('art_decode');
  });
});

describe('EvidenceDrawer deep links (?artifact=…)', () => {
  it('a protocol_decode artifact opens the decode tab with its failed rows tinted', async () => {
    renderDrawer('?artifact=art_decode');
    expect(tab('Protocol Decode')).toHaveAttribute('aria-selected', 'true');
    const table = await screen.findByRole('table', { name: 'Decoded transactions' });
    const failedRows = table.querySelectorAll('tbody tr[data-failed]');
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]).toHaveClass('bg-fail-bg');
    expect(failedRows[0]).toHaveTextContent('0x3B');
    expect(failedRows[0]).toHaveTextContent('NACK (address)');
  });

  it('a T3.2-kind artifact lands on Checks with its rows highlighted and the notice shown', () => {
    renderDrawer('?artifact=art_timing');
    expect(tab('Checks')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(/arrives with T3\.2/);
    const table = screen.getByRole('table', { name: 'Measurement checks' });
    const highlighted = table.querySelectorAll('tbody tr[data-highlighted]');
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toHaveTextContent('i2c_clock');
  });

  it('an unknown artifact id fails closed on Checks with an explicit notice', () => {
    renderDrawer('?artifact=art_ghost');
    expect(tab('Checks')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(
      `Artifact "art_ghost" isn't part of this run's evidence.`,
    );
  });
});

describe('EvidenceDrawer decode failure states', () => {
  it('renders a fail-closed error state on unparseable artifact content, not a crash', async () => {
    vi.spyOn(api, 'getArtifactText').mockResolvedValue('not json at all');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/runs/${RUN_ID}/evidence?artifact=art_decode`]}>
          <EvidenceDrawer view={buildView()} onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Decode artifact unreadable');
    expect(alert).toHaveTextContent('not valid JSON');
    expect(screen.queryByRole('table', { name: 'Decoded transactions' })).not.toBeInTheDocument();
  });

  it('renders a retryable error state when the artifact fetch fails', async () => {
    vi.spyOn(api, 'getArtifactText').mockRejectedValue(new Error('network down'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/runs/${RUN_ID}/evidence?artifact=art_decode`]}>
          <EvidenceDrawer view={buildView()} onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t load the decode artifact');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
