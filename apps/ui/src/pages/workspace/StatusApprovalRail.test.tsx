// Status & Approval rail (T2.2) against a mocked HTTP client: stop behind the
// ConfirmDialog with 409-as-refresh, approve/reject wiring with the idempotency
// window (disabled from click until the confirming event lands), the rail-level
// fail-closed blocked state, the diagnosis/fix-approval interplay, and the elapsed
// timer ticking only while non-terminal. Run state is seeded through the real
// reducer via test-event streams (D5).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { BenchStatus, Event, RunStatus, RunView } from '@boardex/contract';

const stopRun = vi.fn<() => Promise<void>>();
const resolveApproval = vi.fn<() => Promise<void>>();

vi.mock('../../lib/api', () => ({
  api: {
    stopRun: (...args: unknown[]) => (stopRun as (...a: unknown[]) => Promise<void>)(...args),
    resolveApproval: (...args: unknown[]) =>
      (resolveApproval as (...a: unknown[]) => Promise<void>)(...args),
  },
  StateConflict: class StateConflict extends Error {
    readonly currentStatus: RunStatus;
    constructor(message: string, currentStatus: RunStatus) {
      super(message);
      this.name = 'StateConflict';
      this.currentStatus = currentStatus;
    }
  },
}));

// The bench snapshot behind the §7.2 warning's repeat at hardware-action approvals
// (T5.0 adjudication); null (no snapshot) by default so unrelated tests see nothing.
let benchSnapshot: BenchStatus | null = null;
vi.mock('../../lib/useBenchStatus', () => ({
  useBenchStatus: () => benchSnapshot,
}));

import { StatusApprovalRail } from './StatusApprovalRail';
import { StateConflict } from '../../lib/api';
import { approval, artifact, diagnosis, envelope, failedCheck, run, RUN_ID, TS, viewFrom } from './test-events';

const runningView = (): RunView => viewFrom([envelope(1, 'run.created', { run })]);

const awaitingView = (): RunView =>
  viewFrom([
    envelope(1, 'run.created', { run }),
    envelope(2, 'run.status_changed', { status: 'awaiting_approval' }),
    envelope(3, 'approval.requested', { approval: approval('apr_flash') }),
  ]);

const blockedView = (): RunView =>
  viewFrom([
    envelope(1, 'run.created', { run }),
    envelope(2, 'run.status_changed', { status: 'awaiting_approval' }),
  ]);

// The stop event carries a ts 65s after createdAt: the frozen duration must come
// from that envelope ts (§5.4 v1.5), never from the wall clock.
const stoppedView = (): RunView =>
  viewFrom([
    envelope(1, 'run.created', { run }),
    { ...envelope(2, 'run.stopped', { byUser: true }), ts: '2026-07-08T12:01:05.000Z' },
  ]);

const diagnosisEvents = (): Event[] => [
  envelope(1, 'run.created', { run }),
  envelope(2, 'artifact.created', { artifact: artifact('art_decode') }),
  envelope(3, 'check.evaluated', {
    check: failedCheck('chk_device_ack', 'art_decode', 'BME280 must ACK at address 0x76'),
  }),
  envelope(4, 'run.status_changed', { status: 'diagnosing' }),
  envelope(5, 'diagnosis.created', {
    diagnosis: diagnosis(
      [{ cause: 'Address shift missing', evidence: 'Decode shows NACK.', confidence: 'high' }],
      ['chk_device_ack'],
    ),
  }),
];

const diagnosingView = (): RunView => viewFrom(diagnosisEvents());

const fixGateView = (): RunView =>
  viewFrom([
    ...diagnosisEvents(),
    envelope(6, 'run.status_changed', { status: 'awaiting_approval' }),
    envelope(7, 'approval.requested', { approval: approval('apr_fix') }),
  ]);

function renderRail(view: RunView) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StatusApprovalRail view={view} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  benchSnapshot = null;
});

const degradedBench: BenchStatus = {
  runnerOnline: true,
  contractVersion: 'boardex-contract/0.1',
  devices: [
    { id: 'pyocd:stlink:1', kind: 'debug_probe', name: 'ST-Link/V2-1', state: 'online' },
    {
      id: 'sigrok:kingst-la2016:conn=3.12',
      kind: 'logic_analyzer',
      name: 'Kingst LA2016',
      state: 'offline',
      detail: 'Not detected by sigrok',
    },
  ],
};

const healthyBench: BenchStatus = {
  ...degradedBench,
  devices: degradedBench.devices.map((device) => ({
    ...device,
    state: 'online' as const,
    detail: undefined,
  })),
};

describe('stop with confirm + 409', () => {
  it('stops only after the ConfirmDialog confirms, then holds the button disabled', async () => {
    const user = userEvent.setup();
    stopRun.mockResolvedValue(undefined);
    renderRail(runningView());

    await user.click(screen.getByRole('button', { name: 'Stop Run' }));
    expect(stopRun).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'Stop this run?' });
    await user.click(within(dialog).getByRole('button', { name: 'Stop Run' }));
    expect(stopRun).toHaveBeenCalledWith(RUN_ID);
    // Accepted (204): stays disabled until run.stopped arrives via the stream.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('cancelling the dialog sends nothing', async () => {
    const user = userEvent.setup();
    renderRail(runningView());
    await user.click(screen.getByRole('button', { name: 'Stop Run' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(stopRun).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('treats a 409 StateConflict as state refresh, not an error', async () => {
    const user = userEvent.setup();
    stopRun.mockRejectedValue(new StateConflict('run has already reached a terminal state', 'stopped'));
    renderRail(runningView());

    await user.click(screen.getByRole('button', { name: 'Stop Run' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop Run' }),
    );

    // The mutation resets: no alert, and the button re-arms (the stream will
    // reconcile the terminal state and unmount it).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Run' })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces a non-conflict stop failure as an alert', async () => {
    const user = userEvent.setup();
    stopRun.mockRejectedValue(new Error('network down'));
    renderRail(runningView());

    await user.click(screen.getByRole('button', { name: 'Stop Run' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop Run' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not stop the run/i);
  });

  it('renders no Stop Run at all once the run is terminal', () => {
    renderRail(stoppedView());
    expect(screen.queryByRole('button', { name: /stop run/i })).not.toBeInTheDocument();
  });
});

describe('approval resolution', () => {
  it('approves the pending approval and holds both buttons disabled until the event lands', async () => {
    const user = userEvent.setup();
    resolveApproval.mockResolvedValue(undefined);
    renderRail(awaitingView());

    await user.click(screen.getByRole('button', { name: 'Approve & Continue' }));
    expect(resolveApproval).toHaveBeenCalledWith(RUN_ID, 'apr_flash', 'approved');
    // Idempotency window: 204 received, approval.resolved not yet in view.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resolving…' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(resolveApproval).toHaveBeenCalledTimes(1);
  });

  it('rejects the pending approval', async () => {
    const user = userEvent.setup();
    resolveApproval.mockResolvedValue(undefined);
    renderRail(awaitingView());

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(resolveApproval).toHaveBeenCalledWith(RUN_ID, 'apr_flash', 'rejected');
  });

  it('treats a 409 on resolve as state refresh, not an error', async () => {
    const user = userEvent.setup();
    resolveApproval.mockRejectedValue(new StateConflict('approval is not awaiting resolution', 'running'));
    renderRail(awaitingView());

    await user.click(screen.getByRole('button', { name: 'Approve & Continue' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve & Continue' })).toBeEnabled(),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('fail-closed: awaiting_approval with no pending approval renders the blocked card, no Approve in the DOM', () => {
    renderRail(blockedView());
    expect(screen.getByRole('alert')).toHaveTextContent('Approval blocked');
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });
});

describe('diagnosis interplay', () => {
  it('shows the Diagnosis Card while diagnosing, with no Approve Fix Plan yet (fail-closed)', () => {
    renderRail(diagnosingView());
    expect(screen.getByRole('region', { name: 'Diagnosis' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('at the fix gate, the Diagnosis Card is the single approve surface (F1/F3)', async () => {
    const user = userEvent.setup();
    resolveApproval.mockResolvedValue(undefined);
    renderRail(fixGateView());

    // The generic Approval Card is suppressed: exactly one approve control exists.
    expect(screen.queryByRole('region', { name: 'Approval required' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve & Continue' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /approve/i })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Approve Fix Plan' }));
    expect(resolveApproval).toHaveBeenCalledWith(RUN_ID, 'apr_fix', 'approved');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resolving…' })).toBeDisabled());
    expect(resolveApproval).toHaveBeenCalledTimes(1);
  });

  it('a later approval unrelated to the diagnosis gets the generic card, never the Diagnosis Card (F3)', async () => {
    const user = userEvent.setup();
    resolveApproval.mockResolvedValue(undefined);
    renderRail(
      viewFrom([
        ...diagnosisEvents(),
        envelope(6, 'run.status_changed', { status: 'awaiting_approval' }),
        envelope(7, 'approval.requested', { approval: approval('apr_fix') }),
        envelope(8, 'approval.resolved', { approvalId: 'apr_fix', status: 'approved', resolvedAt: TS }),
        envelope(9, 'run.status_changed', { status: 'running' }),
        envelope(10, 'run.status_changed', { status: 'awaiting_approval' }),
        envelope(11, 'approval.requested', { approval: approval('apr_flash2') }),
      ]),
    );

    expect(screen.getByRole('region', { name: 'Approval required' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Diagnosis' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Hypotheses' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve Fix Plan' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve & Continue' }));
    expect(resolveApproval).toHaveBeenCalledWith(RUN_ID, 'apr_flash2', 'approved');
  });

  it('hides the Diagnosis Card once the run moves on (running, iteration 2)', () => {
    renderRail(
      viewFrom([
        ...diagnosisEvents(),
        envelope(6, 'run.status_changed', { status: 'running' }),
        envelope(7, 'run.iteration_started', { iteration: 2, reason: 'Applying fix' }),
      ]),
    );
    expect(screen.queryByRole('region', { name: 'Diagnosis' })).not.toBeInTheDocument();
  });
});

describe('elapsed timer', () => {
  it('derives from run.createdAt and ticks while non-terminal', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(TS) + 5000));
    renderRail(runningView());
    expect(screen.getByRole('region', { name: 'Run status' })).toBeInTheDocument();
    expect(screen.getByText('0:05')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText('0:08')).toBeInTheDocument();
  });

  it('freezes a terminal run at createdAt → endedAt, independent of the wall clock', () => {
    vi.useFakeTimers();
    // Wall clock far past the run: the frozen figure must ignore it entirely.
    vi.setSystemTime(new Date(Date.parse(TS) + 9_000_000));
    renderRail(stoppedView());
    expect(screen.getByText('1:05')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('1:05')).toBeInTheDocument();
  });

  it('freezes identically when the terminal state arrives via run.status_changed (F4)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(TS) + 9_000_000));
    renderRail(
      viewFrom([
        envelope(1, 'run.created', { run }),
        { ...envelope(2, 'run.status_changed', { status: 'stopped' }), ts: '2026-07-08T12:01:05.000Z' },
      ]),
    );
    expect(screen.getByText('1:05')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stop run/i })).not.toBeInTheDocument();
  });
});

describe('bench-degraded warning repeats at hardware-action approvals (T5.0 adjudication)', () => {
  it('renders the §7.2 warning when the pending approval proposes hardware actions', () => {
    benchSnapshot = degradedBench;
    renderRail(awaitingView());
    expect(screen.getByText('Bench degraded')).toBeInTheDocument();
    expect(
      screen.getByText('Kingst LA2016 is on the bench but offline (Not detected by sigrok)'),
    ).toBeInTheDocument();
    // Advisory, never gating: the approve control stays live.
    expect(screen.getByRole('button', { name: /approve & continue/i })).toBeEnabled();
  });

  it('repeats at the fix gate too — re-flash is a hardware action', () => {
    benchSnapshot = degradedBench;
    renderRail(fixGateView());
    expect(screen.getByText('Bench degraded')).toBeInTheDocument();
    // And the Diagnosis Card remains the single approve surface.
    expect(screen.getByRole('button', { name: /approve fix plan/i })).toBeEnabled();
  });

  it('stays silent for an approval with no hardware actions', () => {
    benchSnapshot = degradedBench;
    renderRail(
      viewFrom([
        envelope(1, 'run.created', { run }),
        envelope(2, 'run.status_changed', { status: 'awaiting_approval' }),
        envelope(3, 'approval.requested', {
          approval: approval('apr_sw_only', { hardwareActions: [] }),
        }),
      ]),
    );
    expect(screen.queryByText('Bench degraded')).not.toBeInTheDocument();
  });

  it('stays silent on a healthy bench, and with no bench snapshot at all', () => {
    benchSnapshot = healthyBench;
    const { unmount } = renderRail(awaitingView());
    expect(screen.queryByText('Bench degraded')).not.toBeInTheDocument();
    unmount();

    benchSnapshot = null; // no snapshot: no claim to warn about (never an assumed anything)
    renderRail(awaitingView());
    expect(screen.queryByText('Bench degraded')).not.toBeInTheDocument();
  });
});

describe('contract warnings line (T5.0/F5)', () => {
  const warnedView = (): RunView =>
    viewFrom([
      envelope(1, 'run.created', { run }),
      // Evidence-law violation the stream never repairs: exactly one warning.
      envelope(2, 'check.evaluated', {
        check: failedCheck('chk_orphan', 'art_never_created', 'BME280 must ACK at 0x76'),
      }),
    ]);

  it('renders a compact amber count that expands to the reducer messages', async () => {
    const user = userEvent.setup();
    renderRail(warnedView());

    const toggle = screen.getByRole('button', { name: '1 contract warning' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/art_never_created/)).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/evidence-linking violation/)).toBeInTheDocument();
    expect(screen.getByText(/art_never_created/)).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.queryByText(/art_never_created/)).not.toBeInTheDocument();
  });

  it('renders nothing at zero warnings', () => {
    renderRail(runningView());
    expect(screen.queryByText(/contract warning/)).not.toBeInTheDocument();
  });
});
