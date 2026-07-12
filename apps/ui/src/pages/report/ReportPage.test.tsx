// Validation Report screen (§7.6) at the page level: it reduces the run from the
// real fixture stream (D5), fetches the report_md by reference (D4), and renders it
// with the Copy/Download export actions (D9). Every unhappy path is asserted to fail
// closed — no report artifact (the run.failed fixture legitimately has none), a fetch
// error, and empty content each render an explicit state, never a blank or a crash.
// Run state is seeded through the real store; only the stream hook and HTTP client
// are mocked.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Run, WireEvent } from '@boardex/contract';

const getArtifactText = vi.fn<(id: string) => Promise<string>>();
const getArtifactBlob = vi.fn<(id: string, mimeType: string) => Promise<Blob>>();

vi.mock('../../lib/api', () => ({
  api: {
    getArtifactText: (id: string) => getArtifactText(id),
    getArtifactBlob: (id: string, mimeType: string) => getArtifactBlob(id, mimeType),
    // Documents back the report's sourceRef → Sources links (T6.3); none in these tests.
    listBoardProfiles: () => Promise.resolve([]),
  },
}));
vi.mock('../../lib/useRunStream', () => ({ useRunStream: () => 'open' }));

import ReportPage from './ReportPage';
import { useRunStore } from '../../lib/runStore';

const RUN_ID = 'run_bme280_001';

// Resolve fixtures from the package cwd (apps/ui) — see ReportView.test for why we
// avoid new URL(…, import.meta.url) here.
const fixtureFile = (rel: string): string =>
  readFileSync(resolve(process.cwd(), '../../packages/contract/fixtures', rel), 'utf8');

const REPORT_MD = fixtureFile('artifacts/art_report.md');

const seedRun = (fixtureName: string) => {
  const events = fixtureFile(fixtureName)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line).event as WireEvent);
  useRunStore.getState().ingestMany(RUN_ID, events);
};

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}/report`]}>
        <Routes>
          <Route path="/runs/:id/report" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeAll(() => {
  // jsdom has no object-URL support; the download's Blob save path needs it not to throw.
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });
});

beforeEach(() => {
  getArtifactText.mockReset();
  getArtifactBlob.mockReset();
  useRunStore.getState().resetAll();
});

afterEach(() => {
  useRunStore.getState().resetAll();
});

describe('ReportPage — completed run with a report', () => {
  beforeEach(() => {
    getArtifactText.mockResolvedValue(REPORT_MD);
    getArtifactBlob.mockResolvedValue(new Blob([REPORT_MD], { type: 'text/markdown' }));
    seedRun('bme280_run_001.jsonl');
  });

  it('renders the report with its heading and export actions', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: /Validation Report — BME280 bring-up/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Markdown' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download .md' })).toBeInTheDocument();
  });

  it('copies the raw Markdown to the clipboard with confirmation feedback', async () => {
    // userEvent installs a working clipboard stub for the duration of setup.
    const user = userEvent.setup();
    renderPage();
    const copy = await screen.findByRole('button', { name: 'Copy Markdown' });
    await user.click(copy);
    expect(await navigator.clipboard.readText()).toBe(REPORT_MD);
    expect(await screen.findByRole('button', { name: 'Copied ✓' })).toBeInTheDocument();
  });

  it('downloads the report by reference through the artifact blob path', async () => {
    const user = userEvent.setup();
    renderPage();
    const download = await screen.findByRole('button', { name: 'Download .md' });
    await user.click(download);
    expect(getArtifactBlob).toHaveBeenCalledWith('art_report', 'text/markdown');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ReportPage — fail-closed states', () => {
  it('renders a retryable error when the report fetch fails', async () => {
    getArtifactText.mockRejectedValue(new Error('boom'));
    seedRun('bme280_run_001.jsonl');
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t load the report');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // No export actions offered when there is nothing to export.
    expect(screen.queryByRole('button', { name: 'Copy Markdown' })).not.toBeInTheDocument();
  });

  it('renders an unreadable state when the fetched report is empty', async () => {
    getArtifactText.mockResolvedValue('   \n  ');
    seedRun('bme280_run_001.jsonl');
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Report unreadable');
  });
});

describe('ReportPage — fail-variant run with no report', () => {
  it('renders the honest empty state for a run.failed with no report artifact', async () => {
    seedRun('bme280_run_001_fail.jsonl');
    renderPage();
    // The reduced fail run is terminal-failed and never produced a report_md.
    expect(await screen.findByText('No report for this run')).toBeInTheDocument();
    expect(screen.getByText(/ended before it produced a validation report/)).toBeInTheDocument();
    // Fail-closed: no report fetch is even attempted, and no export actions appear.
    expect(getArtifactText).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Copy Markdown' })).not.toBeInTheDocument();
  });
});

// T6.3/T6.6: model attribution renders in the report header when the run echoed one.
describe('ReportPage — model attribution (T6.3)', () => {
  it('renders the run model in the header when echoed', async () => {
    const events = fixtureFile('bme280_run_001.jsonl')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line).event as WireEvent)
      .map((event): WireEvent =>
        event.type === 'run.created'
          ? {
              ...event,
              payload: { run: { ...(event.payload as { run: Run }).run, model: 'mock-model' } },
            }
          : event,
      );
    useRunStore.getState().ingestMany(RUN_ID, events);
    getArtifactText.mockResolvedValue(REPORT_MD);
    renderPage();
    expect(await screen.findByText(/Model: mock-model/)).toBeInTheDocument();
  });
});
