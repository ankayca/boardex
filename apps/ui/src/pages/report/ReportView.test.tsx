// ReportView (§7.6) renders the runner-authored report_md with house typography and
// turns artifact-label references into evidence deep links. These cases run against
// the REAL fixture report + its reduced artifacts (the same bytes the mock runner
// serves), so the presentation can never drift from the fixture. The deep-link law
// is asserted both ways: a label present in RunView.artifacts becomes a link; an
// absent one stays plain text — fail-closed, no dead href.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { reduceRun, type Artifact, type RunView, type WireEvent } from '@boardex/contract';
import { ReportView } from './ReportView';

// Resolve fixtures from the package cwd (apps/ui) rather than new URL(…,
// import.meta.url): Vite statically rewrites the latter as an asset reference, which
// a dynamic ${rel} segment breaks. These are the same bytes the mock runner serves.
const fixtureFile = (rel: string): string =>
  readFileSync(resolve(process.cwd(), '../../packages/contract/fixtures', rel), 'utf8');

const REPORT_MD = fixtureFile('artifacts/art_report.md');

const fixtureView = (): RunView => {
  const events = fixtureFile('bme280_run_001.jsonl')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line).event as WireEvent);
  const view = reduceRun(events);
  if (!view) throw new Error('fixture did not reduce to a view');
  return view;
};

const renderView = (markdown: string, artifacts: readonly Artifact[], runId = 'run_bme280_001') =>
  render(
    <MemoryRouter>
      <ReportView markdown={markdown} runId={runId} artifacts={artifacts} />
    </MemoryRouter>,
  );

describe('ReportView against the real fixture', () => {
  it('renders the report heading and the measurement results table', () => {
    const view = fixtureView();
    renderView(REPORT_MD, view.artifacts);

    expect(
      screen.getByRole('heading', { level: 1, name: /Validation Report — BME280 bring-up/ }),
    ).toBeInTheDocument();

    // The measurement results table renders with its header and a requirement row.
    const clockCode = screen.getByText('i2c_clock');
    const table = clockCode.closest('table');
    expect(table).not.toBeNull();
    expect(within(table as HTMLTableElement).getByText('Requirement')).toBeInTheDocument();
    expect(within(table as HTMLTableElement).getByText('Expected')).toBeInTheDocument();
  });

  it('turns a bold artifact-label reference into an evidence deep link', () => {
    const view = fixtureView();
    renderView(REPORT_MD, view.artifacts);

    // "Code diff — BME280 driver (iteration 1)" is an artifact label; its id is the
    // one the reducer carries for that label.
    const artifactId = view.artifacts.find(
      (a) => a.label === 'Code diff — BME280 driver (iteration 1)',
    )?.id;
    expect(artifactId).toBeDefined();

    const link = screen.getAllByRole('link', {
      name: 'Code diff — BME280 driver (iteration 1)',
    })[0];
    expect(link).toHaveAttribute(
      'href',
      `/runs/run_bme280_001/evidence?artifact=${artifactId}`,
    );
  });

  it('turns a plain-text label cell in the artifacts index into a deep link', () => {
    const view = fixtureView();
    renderView(REPORT_MD, view.artifacts);
    const serialId = view.artifacts.find((a) => a.label === 'Serial log (iteration 2)')?.id;
    // The label appears in the results table (plain text) and the artifacts index —
    // both resolve to the same evidence link.
    const links = screen.getAllByRole('link', { name: 'Serial log (iteration 2)' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', `/runs/run_bme280_001/evidence?artifact=${serialId}`);
    }
  });
});

describe('ReportView deep-link resolution (fail-closed)', () => {
  const present: Artifact = {
    id: 'art_build_1',
    runId: 'run_x',
    stepId: 'st',
    kind: 'build_log',
    label: 'Build log (iteration 1)',
    mimeType: 'text/plain',
    sizeBytes: 10,
  };

  it('links a resolvable label and leaves an unresolvable one as plain text', () => {
    renderView(
      'See **Build log (iteration 1)** and **Ghost log** for detail.',
      [present],
      'run_x',
    );
    const link = screen.getByRole('link', { name: 'Build log (iteration 1)' });
    expect(link).toHaveAttribute('href', '/runs/run_x/evidence?artifact=art_build_1');

    // The unresolvable reference renders as text, never as a link (no dead href).
    expect(screen.queryByRole('link', { name: 'Ghost log' })).not.toBeInTheDocument();
    expect(screen.getByText('Ghost log')).toBeInTheDocument();
  });
});
