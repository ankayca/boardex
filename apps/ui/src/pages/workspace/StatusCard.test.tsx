// StatusCard dual-outcome render (§7.3 v2.4, Sprint 7 review F1): once a run is
// terminal the card renders the split — "Run execution" (terminal status + the
// terminal reason) and "Validation coverage" (recorded checks vs the declared
// registry) — pinned to the three coverage shapes the fixtures drive end to end:
// full coverage (bme280_run_001), 2-of-6 partial (bme280_run_002_partial_synthetic),
// and the no-registry fallback line (a pre-v2.4 stream, records/bmp180-run's shape).
// Views come from the real reducer over the real fixture streams (D5), so deleting
// the card's render block fails these assertions against the proven strings.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { reduceRun, type Event, type RunView } from '@boardex/contract';
import { StatusCard } from './StatusCard';
import { deriveDualOutcome } from './outcome';

// Resolve fixtures from the package cwd (apps/ui), the ReportPage.test convention.
const fixtureEvents = (rel: string): Event[] =>
  readFileSync(resolve(process.cwd(), '../../packages/contract/fixtures', rel), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line).event as Event);

const viewOf = (events: Event[]): RunView => {
  const view = reduceRun(events);
  if (view === null) throw new Error('expected the fixture stream to materialize a view');
  return view;
};

// A pre-v2.4 producer's shape: the same stream, no declared registry.
const withoutRegistry = (events: Event[]): Event[] =>
  events.map((event) =>
    event.type === 'run.plan_generated'
      ? { ...event, payload: { plan: event.payload.plan, riskSummary: event.payload.riskSummary } }
      : event,
  );

const renderCard = (view: RunView) =>
  render(
    <StatusCard
      run={view.run}
      endedAt={view.endedAt}
      warnings={view.warnings}
      progress={{ completed: 0, total: 0 }}
      outcome={deriveDualOutcome(view)}
      stopping={false}
      stopError={null}
      onStop={() => {}}
    />,
  );

// The dt/dd pairs render inline inside one line each — assert on the line's text.
const executionLine = () => screen.getByText('Run execution').parentElement;
const coverageLine = () => screen.getByText('Validation coverage').parentElement;

describe('StatusCard dual outcome (§7.3 v2.4)', () => {
  it('renders the execution/coverage split for all three coverage shapes', () => {
    // Full coverage: 3 declared, 3 recorded, completed with the terminal summary.
    const full = renderCard(viewOf(fixtureEvents('bme280_run_001.jsonl')));
    expect(executionLine()).toHaveTextContent(
      'Run execution — Completed · BME280 bring-up validated on iteration 2',
    );
    expect(coverageLine()).toHaveTextContent('Validation coverage — 3 of 3 checks recorded');
    full.unmount();

    // Partial coverage: 6 declared, 2 recorded, turn-budget failure (synthetic fixture).
    const partial = renderCard(viewOf(fixtureEvents('bme280_run_002_partial_synthetic.jsonl')));
    expect(executionLine()).toHaveTextContent(
      'Run execution — Failed · Run terminated by harness: turn bound exceeded: max_turns=40 (4 of 6 registered checks were never recorded)',
    );
    expect(coverageLine()).toHaveTextContent('Validation coverage — 2 of 6 checks recorded');
    partial.unmount();

    // No registry declared: coverage renders WITHOUT a denominator, never an invented one.
    renderCard(viewOf(withoutRegistry(fixtureEvents('bme280_run_001.jsonl'))));
    expect(coverageLine()).toHaveTextContent(
      'Validation coverage — 3 checks recorded · no check registry declared',
    );
  });
});
