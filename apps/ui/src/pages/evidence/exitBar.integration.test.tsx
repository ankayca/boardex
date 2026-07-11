// The §7.4 exit bar, asserted end to end: "every verdict in the fixture is
// traceable to its artifact in ≤2 clicks." The completed fixture run is walked
// check by check — every MeasurementCheck in RunView, not a hand-picked subset —
// from its Evidence Summary chip on the workspace to the artifact backing it,
// and each walk is asserted to cost exactly one click.
//
// The same run first parks at the flash approval gate, where the Approval Card's
// Review Diff must deep-link the run's latest code_diff artifact (§7.3). The
// fixture emits art_diff_iter1 (seq 12) before the gate opens (seq 20), so the
// control is live there; the no-diff-yet fail-closed branch is unit-tested.
//
// Real HTTP + WebSocket + artifact fetch + Zod parse; only the runner URL is
// stubbed. Everything that reads lib/config (App → api singleton) is imported
// dynamically AFTER the runner is up and VITE_RUNNER_URL is stubbed, so the api
// the tabs fetch with binds to the ephemeral port.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import { reduceRun, type RunView } from '@boardex/contract';
import type { ComponentType } from 'react';
import type { ApiClient } from '../../lib/api';
import { checkLabel } from '../workspace/evidence';

let runner: MockRunner;
let App: ComponentType;
let client: ApiClient;
let runId: string;
const hadWebSocket = 'WebSocket' in globalThis;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function currentView(id: string): Promise<RunView | null> {
  const events = await client.getRunEvents(id);
  return events.length === 0 ? null : reduceRun(events);
}

async function waitForView(
  id: string,
  pred: (view: RunView) => boolean,
  timeoutMs = 30000,
): Promise<RunView> {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    const view = await currentView(id);
    if (view && pred(view)) return view;
    await sleep(50);
  }
  throw new Error('timeout waiting for run state');
}

const pendingApproval = (view: RunView) =>
  view.approvals.find((approval) => approval.status === 'pending');

beforeAll(async () => {
  runner = await createMockRunner({ port: 0, speed: 200 });
  vi.stubEnv('VITE_RUNNER_URL', runner.url);
  (globalThis as Record<string, unknown>).WebSocket = WebSocket;
  App = (await import('../../App')).default;
  client = (await import('../../lib/api')).createApiClient(runner.url);

  const created = await client.createRun({
    taskPrompt: 'Bring up the BME280 sensor over I2C.',
    boardProfileId: 'bp_nucleo_f303re',
  });
  runId = created.runId;
  await waitForView(runId, (view) => view.run.status === 'plan_ready');
  await client.approvePlan(runId);
  await waitForView(runId, (view) => pendingApproval(view) !== undefined);
}, 60000);

// jsdom reports zero offset sizes, so the LogViewer's virtualizer would render
// no rows at all — give every element a box (same treatment as LogViewer.test).
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 640,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 320,
  });
});

afterAll(async () => {
  await runner.close();
  vi.unstubAllEnvs();
  if (!hadWebSocket) delete (globalThis as Record<string, unknown>).WebSocket;
});

function renderApp(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('§7.3 Review Diff at the flash approval gate', () => {
  it('deep-links the Code Diff tab at the run’s latest code_diff artifact', async () => {
    const user = userEvent.setup();
    const { unmount } = renderApp(`/runs/${runId}`);

    // The fixture's flash gate opens after the iteration-1 diff artifact lands, so
    // the deep link exists at the moment the card renders. Both halves of that
    // ordering are asserted here — the gate is pending AND the diff exists — so
    // the claim stands on its own rather than on the runner's pause semantics.
    const atGate = await currentView(runId);
    expect(pendingApproval(atGate!)).toBeDefined();
    expect(atGate?.artifacts.some((artifact) => artifact.kind === 'code_diff')).toBe(true);

    const card = await screen.findByRole(
      'region',
      { name: 'Approval required' },
      { timeout: 20000 },
    );
    const reviewDiff = within(card).getByRole('link', { name: 'Review Diff' });
    expect(reviewDiff).toHaveAttribute('href', `/runs/${runId}/evidence?artifact=art_diff_iter1`);

    // One click: the drawer opens on Code Diff with the iteration-1 diff rendered.
    await user.click(reviewDiff);
    const dialog = await screen.findByRole('dialog', { name: 'Evidence' });
    expect(within(dialog).getByRole('tab', { name: 'Code Diff' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      await within(dialog).findByText('Code diff — BME280 driver (iteration 1)', undefined, {
        timeout: 15000,
      }),
    ).toBeInTheDocument();
    unmount();
  }, 90000);
});

// What each check's artifact looks like once it is on screen: the tab the deep link
// must select, and an assertion proving the exact artifact — not merely its tab —
// is what the drawer put in front of the user. Keyed by requirementId; the walk
// asserts this table covers every check in the completed run.
//
// The Raw tab lists every artifact, so its assertion is the highlighted row, not
// the mere presence of a label. Decode and Logs each render only their subject's
// label, so a wrong subject would fail those outright.
interface EvidenceExpectation {
  tab: string;
  assertEvidence: (dialog: HTMLElement) => void;
}

const EXPECTED: Record<string, EvidenceExpectation> = {
  i2c_clock: {
    tab: 'Raw artifacts',
    assertEvidence: (dialog) => {
      const rows = within(dialog)
        .getByRole('table', { name: 'Raw artifacts' })
        .querySelectorAll('tbody tr[data-highlighted]');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveTextContent('SCL frequency measurement (iteration 2)');
    },
  },
  device_ack: {
    tab: 'Protocol Decode',
    assertEvidence: (dialog) => {
      expect(within(dialog).getByText('I2C protocol decode (iteration 2)')).toBeInTheDocument();
      expect(
        within(dialog).getByRole('table', { name: 'Decoded transactions' }),
      ).toBeInTheDocument();
    },
  },
  serial_output: {
    tab: 'Logs',
    assertEvidence: (dialog) => {
      const logTabs = within(dialog).getByRole('tablist', { name: 'Log artifacts' });
      expect(within(logTabs).getByRole('tab', { name: 'Serial — iteration 2' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(within(dialog).getByText('Serial log (iteration 2)')).toBeInTheDocument();
    },
  },
};

describe('§7.4 exit bar: every verdict traceable to its artifact in ≤2 clicks', () => {
  let completed: RunView;

  // Drive the run to completion: approve the flash, then the fix plan, then let
  // iteration 2 evaluate and the report land.
  beforeAll(async () => {
    const atFlashGate = await waitForView(runId, (view) => pendingApproval(view) !== undefined);
    await client.resolveApproval(runId, pendingApproval(atFlashGate)!.id, 'approved');
    const atFixGate = await waitForView(
      runId,
      (view) => view.diagnosis !== undefined && pendingApproval(view) !== undefined,
    );
    await client.resolveApproval(runId, pendingApproval(atFixGate)!.id, 'approved');
    completed = await waitForView(runId, (view) => view.run.status === 'completed', 60000);
  }, 90000);

  it('walks every check in the completed run from its chip to its artifact in one click', async () => {
    // The walk covers the fixture's checks exhaustively — no subset, no placeholder.
    expect(completed.checks.map((check) => check.requirementId).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );

    for (const check of completed.checks) {
      const expectation = EXPECTED[check.requirementId]!;
      const user = userEvent.setup();
      const { unmount } = renderApp(`/runs/${runId}`);

      // What enforces the bar: the walk routes its single click through this
      // counter (asserted toBe(1) below), and findByRole('dialog') plus the tab
      // and content assertions prove that one click alone put the exact artifact
      // on screen — no uncounted interaction exists between chip and evidence.
      let clicks = 0;
      const click = async (element: Element): Promise<void> => {
        clicks += 1;
        await user.click(element);
      };

      const band = await screen.findByRole('list', { name: 'Evidence checks' }, { timeout: 20000 });
      const chip = within(band).getByRole('link', {
        name: new RegExp(checkLabel(check.requirementId)),
      });
      expect(chip).toHaveAttribute('href', `/runs/${runId}/evidence?artifact=${check.artifactId}`);

      await click(chip);

      const dialog = await screen.findByRole('dialog', { name: 'Evidence' });
      expect(within(dialog).getByRole('tab', { name: expectation.tab })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      // Content arrives over a real artifact fetch + parse.
      await waitFor(() => expectation.assertEvidence(dialog), { timeout: 15000 });
      expect(clicks).toBe(1);
      unmount();
    }
  }, 120000);
});
