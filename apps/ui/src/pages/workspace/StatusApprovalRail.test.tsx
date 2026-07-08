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
import type { Event, RunStatus, RunView } from '@boardex/contract';

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
});

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

  it('at the fix gate, Approve Fix Plan approves the pending fix approval and disables every approve control', async () => {
    const user = userEvent.setup();
    resolveApproval.mockResolvedValue(undefined);
    renderRail(fixGateView());

    expect(screen.getByRole('region', { name: 'Approval required' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve Fix Plan' }));
    expect(resolveApproval).toHaveBeenCalledWith(RUN_ID, 'apr_fix', 'approved');
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Resolving…' })).toHaveLength(2),
    );
    expect(resolveApproval).toHaveBeenCalledTimes(1);
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
});
