// @vitest-environment node
//
// Transport integration tests: the api + ws clients driven against a live mock
// runner over real HTTP + WebSocket (BIBLE §5.3/§5.4). Covers the core reconnect +
// HTTP-replay path (a mid-run socket drop must reduce to an identical view), initial
// replay of pre-connect events, typed 409 handling, and the global runner.status feed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import { createApiClient, StateConflict, type ApiClient } from './api';
import { connectRunStream } from './runStream';
import { createRunStore, type RunStore } from './runStore';
import { WsClient, type WebSocketCtor, type WsConnectionStatus } from './ws';

const WS_IMPL = WebSocket as unknown as WebSocketCtor;
const TERMINAL = new Set(['completed', 'failed', 'stopped']);
const BOARD = 'bp_nucleo_f303re';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 20000): Promise<void> {
  const step = 10;
  for (let waited = 0; waited < timeoutMs; waited += step) {
    if (pred()) return;
    await sleep(step);
  }
  throw new Error('timeout waiting for condition');
}

let runner: MockRunner;
let api: ApiClient;
let wsBase: string;

beforeAll(async () => {
  // Ephemeral port; SPEED=200 keeps a full 90-event run to a couple of seconds.
  runner = await createMockRunner({ port: 0, speed: 200 });
  api = createApiClient(runner.url);
  wsBase = runner.url.replace('http://', 'ws://');
});

afterAll(async () => {
  await runner.close();
});

// Drive a run to a terminal state through the store view: approve the plan when it is
// ready and approve every pending approval as it appears. Mirrors a user clicking
// through, but sourced entirely from the reduced view (the only derivation path).
async function driveToTerminal(runId: string, store: RunStore): Promise<void> {
  const resolved = new Set<string>();
  for (let i = 0; i < 4000; i++) {
    const view = store.getState().runs[runId]?.view;
    if (view) {
      if (TERMINAL.has(view.run.status)) return;
      if (view.run.status === 'plan_ready' && !resolved.has('__plan__')) {
        try {
          await api.approvePlan(runId);
          resolved.add('__plan__');
        } catch {
          // command raced ahead of the view; retry on the next tick
        }
      }
      const pending = view.approvals.find((a) => a.status === 'pending');
      if (pending && !resolved.has(pending.id)) {
        try {
          await api.resolveApproval(runId, pending.id, 'approved');
          resolved.add(pending.id);
        } catch {
          // same: the gate may not be registered server-side yet
        }
      }
    }
    await sleep(10);
  }
  throw new Error('run did not reach a terminal state in time');
}

describe('transport integration', () => {
  it('reconnects after a mid-run WS drop and replays to an identical completed view', async () => {
    const { runId } = await api.createRun({ taskPrompt: 'bring up BME280', boardProfileId: BOARD });
    const store = createRunStore();
    const statuses: WsConnectionStatus[] = [];
    const client = connectRunStream({
      runId,
      api,
      store,
      wsBase,
      WebSocketImpl: WS_IMPL,
      heartbeatTimeoutMs: 0, // exercise reconnect via an explicit drop, not the watchdog
      onStatusChange: (status) => statuses.push(status),
    });

    // Start driving, then sever the socket once the run is underway.
    const driving = driveToTerminal(runId, store);
    await waitFor(() => store.getState().runs[runId]?.view?.run.status === 'running');
    // The drop must land mid-run: capture the status at that instant and assert it is
    // non-terminal, so this genuinely exercises reconnect-during-an-active-run.
    const statusAtDrop = store.getState().runs[runId]?.view?.run.status;
    expect(statusAtDrop).toBeDefined();
    expect(TERMINAL.has(statusAtDrop as string)).toBe(false);
    client.simulateDrop();
    await waitFor(() => statuses.includes('reconnecting'));

    await driving;
    const view = store.getState().runs[runId]?.view;

    // Identical to a clean, uninterrupted run: gapless 1..90, completed, one fix loop,
    // all three checks passing, both approvals resolved, evidence-linking law clean.
    expect(view?.run.status).toBe('completed');
    expect(view?.lastSeq).toBe(90);
    expect(store.getState().runs[runId]?.events).toHaveLength(90);
    expect(view?.run.iteration).toBe(2);
    expect(view?.checks).toHaveLength(3);
    expect(view?.checks.every((c) => c.verdict === 'pass')).toBe(true);
    expect(view?.approvals).toHaveLength(2);
    expect(view?.approvals.every((a) => a.status === 'approved')).toBe(true);
    expect(view?.warnings).toEqual([]);
    // The socket genuinely dropped and came back live (>= 2 distinct 'open' phases).
    expect(statuses.filter((s) => s === 'open').length).toBeGreaterThanOrEqual(2);

    client.close();
  }, 40000);

  it('cycles a silent socket via the heartbeat watchdog and recovers the run', async () => {
    const { runId } = await api.createRun({ taskPrompt: 'bring up BME280', boardProfileId: BOARD });
    const store = createRunStore();
    const statuses: WsConnectionStatus[] = [];
    const client = connectRunStream({
      runId,
      api,
      store,
      wsBase,
      WebSocketImpl: WS_IMPL,
      // Short watchdog: the runner is silent for far longer than this while paused at
      // an approval gate, so the socket is cycled with no explicit drop.
      heartbeatTimeoutMs: 150,
      onStatusChange: (status) => statuses.push(status),
    });

    // Approve the plan, then deliberately sit idle at the first approval gate.
    await waitFor(() => store.getState().runs[runId]?.view?.run.status === 'plan_ready');
    await api.approvePlan(runId);
    await waitFor(
      () => store.getState().runs[runId]?.view?.approvals.some((a) => a.status === 'pending') ?? false,
    );

    const opensBeforeIdle = statuses.filter((s) => s === 'open').length;
    // Silence at the gate for well over the watchdog window + a reconnect backoff.
    await sleep(900);
    // The watchdog cycled and re-opened the socket without any explicit drop.
    expect(statuses.filter((s) => s === 'open').length).toBeGreaterThan(opensBeforeIdle);

    // The run still completes cleanly and the reduced view is unharmed.
    await driveToTerminal(runId, store);
    const view = store.getState().runs[runId]?.view;
    expect(view?.run.status).toBe('completed');
    expect(view?.lastSeq).toBe(90);
    expect(view?.checks.every((c) => c.verdict === 'pass')).toBe(true);
    expect(view?.warnings).toEqual([]);

    client.close();
  }, 40000);

  it('replays events emitted before the socket connected', async () => {
    const { runId } = await api.createRun({ taskPrompt: 'bring up BME280', boardProfileId: BOARD });

    // Let the runner emit several events with no client attached.
    let seeded = 0;
    for (let i = 0; i < 400 && seeded < 3; i++) {
      seeded = (await api.getRunEvents(runId, 0)).length;
      await sleep(10);
    }
    expect(seeded).toBeGreaterThanOrEqual(3);

    const store = createRunStore();
    const client = connectRunStream({
      runId,
      api,
      store,
      wsBase,
      WebSocketImpl: WS_IMPL,
      heartbeatTimeoutMs: 0,
    });

    // The pre-connect events arrive via the initial HTTP replay, starting at seq 1.
    await waitFor(() => (store.getState().runs[runId]?.events.length ?? 0) >= 3);
    expect(store.getState().runs[runId]?.events[0]?.type).toBe('run.created');

    await driveToTerminal(runId, store);
    expect(store.getState().runs[runId]?.view?.run.status).toBe('completed');

    client.close();
  }, 40000);

  it('surfaces an invalid-state command as a typed StateConflict', async () => {
    const { runId } = await api.createRun({ taskPrompt: 'bring up BME280', boardProfileId: BOARD });
    const store = createRunStore();
    const client = connectRunStream({
      runId,
      api,
      store,
      wsBase,
      WebSocketImpl: WS_IMPL,
      heartbeatTimeoutMs: 0,
    });

    await waitFor(() => store.getState().runs[runId]?.view?.run.status === 'plan_ready');
    await api.approvePlan(runId); // first approval: 204

    // The plan gate is already released; a second approve is invalid for the state.
    let caught: unknown;
    try {
      await api.approvePlan(runId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateConflict);
    expect((caught as StateConflict).currentStatus).toBeTruthy();

    client.close();
  }, 40000);

  it('delivers runner.status over the global WS on connect', async () => {
    let benchSeen = false;
    const client = new WsClient({
      wsBase,
      target: { kind: 'global' },
      WebSocketImpl: WS_IMPL,
      heartbeatTimeoutMs: 0,
      onEvent: (event) => {
        if (event.type === 'runner.status') benchSeen = true;
      },
    });
    client.connect();
    await waitFor(() => benchSeen);
    expect(benchSeen).toBe(true);
    client.close();
  }, 20000);
});
