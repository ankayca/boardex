// Checks tab (§7.4): the table over RunView.checks — requirement id, description,
// humanized expected window, actual with unit, verdict badge, sourceRef, and the
// per-row "view evidence" link with the band's exact fail-closed treatment: an
// unresolvable artifactId renders inert (aria-disabled, no href). Views come from
// the real reduceRun (D5).
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Event, MeasurementCheck, RunView } from '@boardex/contract';
import { ChecksTab } from './ChecksTab';
import { artifactOf, envelope, run, RUN_ID } from '../workspace/test-events';
import { reduceRun } from '@boardex/contract';

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
  sourceRef: 'BME280 datasheet §6.2',
};

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

// artifactId with no artifact.created → reducer downgrades to needs_review; the
// row's evidence link must render inert.
const orphanCheck: MeasurementCheck = {
  id: 'chk_serial',
  runId: RUN_ID,
  requirementId: 'serial_output',
  description: 'Serial console must print TEMP/HUM readings',
  measurement: 'serial.console.output_pattern',
  expected: { pattern: 'TEMP=\\d+\\.\\d' },
  actual: { value: 'no TEMP/HUM line' },
  verdict: 'fail',
  artifactId: 'art_missing',
};

function buildView(): RunView {
  const stream: Event[] = [
    envelope(1, 'run.created', { run }),
    envelope(2, 'artifact.created', { artifact: artifactOf('art_timing', 'timing_measurement') }),
    envelope(3, 'artifact.created', { artifact: artifactOf('art_decode', 'protocol_decode') }),
    envelope(4, 'check.evaluated', { check: clockCheck }),
    envelope(5, 'check.evaluated', { check: ackCheck }),
    envelope(6, 'check.evaluated', { check: orphanCheck }),
  ];
  return reduceRun(stream);
}

function renderTab(view: RunView, highlightArtifactId: string | null = null) {
  return render(
    <MemoryRouter>
      <ChecksTab view={view} highlightArtifactId={highlightArtifactId} />
    </MemoryRouter>,
  );
}

const rows = () => within(screen.getByRole('table', { name: 'Measurement checks' })).getAllByRole('row');

describe('ChecksTab', () => {
  it('renders one row per check with requirement, window, actual, verdict, and source', () => {
    renderTab(buildView());
    const [, clockRow, ackRow, orphanRow] = rows();

    expect(clockRow).toHaveTextContent('i2c_clock');
    expect(clockRow).toHaveTextContent('I2C SCL clock must be 100 kHz ±10%');
    expect(clockRow).toHaveTextContent('90,000 – 110,000 Hz');
    expect(clockRow).toHaveTextContent('99,600 Hz');
    expect(clockRow).toHaveTextContent('BME280 datasheet §6.2');
    expect(clockRow!.querySelector('[data-kind="verdict"][data-value="pass"]')).not.toBeNull();

    expect(ackRow).toHaveTextContent('= true');
    expect(ackRow).toHaveTextContent('false');
    expect(ackRow!.querySelector('[data-kind="verdict"][data-value="fail"]')).not.toBeNull();
    // No sourceRef → em dash, not an empty cell.
    expect(within(ackRow!).getAllByRole('cell')[4]).toHaveTextContent('—');

    expect(orphanRow).toHaveTextContent('matches TEMP=\\d+\\.\\d');
    // The reducer downgraded the orphaned artifactId to needs_review.
    expect(orphanRow!.querySelector('[data-kind="verdict"][data-value="needs_review"]')).not.toBeNull();
  });

  it('links resolvable rows to their artifact and renders the orphaned row inert', () => {
    renderTab(buildView());
    const [, clockRow, ackRow, orphanRow] = rows();

    expect(within(clockRow!).getByRole('link', { name: 'View evidence' })).toHaveAttribute(
      'href',
      `/runs/${RUN_ID}/evidence?artifact=art_timing`,
    );
    expect(within(ackRow!).getByRole('link', { name: 'View evidence' })).toHaveAttribute(
      'href',
      `/runs/${RUN_ID}/evidence?artifact=art_decode`,
    );

    // Fail-closed: aria-disabled, no href, no link role — same treatment as the band.
    expect(within(orphanRow!).queryByRole('link')).not.toBeInTheDocument();
    const inert = orphanRow!.querySelector('[aria-disabled="true"]');
    expect(inert).not.toBeNull();
    expect(inert).toHaveTextContent('View evidence');
    expect(inert).not.toHaveAttribute('href');
  });

  it('highlights the rows backed by the deep-linked artifact', () => {
    renderTab(buildView(), 'art_timing');
    const [, clockRow, ackRow] = rows();
    expect(clockRow).toHaveAttribute('data-highlighted');
    expect(ackRow).not.toHaveAttribute('data-highlighted');
  });

  it('renders a quiet status line before any check is evaluated', () => {
    const view = reduceRun([envelope(1, 'run.created', { run })]);
    renderTab(view);
    expect(screen.getByRole('status')).toHaveTextContent('No checks have been evaluated yet.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
