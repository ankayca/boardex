// @vitest-environment node
//
// The D5 proof for run history (T5.2, per the T2.3 pattern): drive a run to a
// terminal state in a live session (WS + replay), then cold-load the same run in a
// completely fresh store — a new browser session — and assert the replayed RunView
// deep-equals the live session's final view: run, steps, artifacts, checks,
// approvals, diagnosis, logsByStep (Map), iterations, endedAt, lastSeq, warnings.
// The cold load must construct NO WebSocket (spied on the constructor): terminal
// runs render from GET /runs/{id}/events alone, so a runner refusing sockets for
// archived runs works perfectly. The fail variant and the stop path are the two
// test vehicles — the terminals §7.1's history rows actually surface.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import type { RunView } from '@boardex/contract';
import { createApiClient, type ApiClient } from './api';
import { connectRunStream, type RunStreamStatus } from './runStream';
import { createRunStore, type RunStore } from './runStore';
import type { WebSocketCtor } from './ws';

const WS_IMPL = WebSocket as unknown as WebSocketCtor;
const TERMINAL = new Set(['completed', 'failed', 'stopped']);
const BOARD = 'bp_nucleo_f303re';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 20000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 10) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error('timeout waiting for condition');
}

// Counts every socket construction — the cold-load assertion is that this stays 0.
let socketConstructions = 0;
class CountingWebSocket extends WebSocket {
  constructor(url: string) {
    socketConstructions++;
    super(url);
  }
}

let runner: MockRunner;
let failRunner: MockRunner;

beforeAll(async () => {
  runner = await createMockRunner({ port: 0, speed: 200 });
  failRunner = await createMockRunner({ port: 0, speed: 200, failVariant: true });
});

afterAll(async () => {
  await runner.close();
  await failRunner.close();
});

function liveConnect(api: ApiClient, runId: string, store: RunStore, wsBase: string) {
  return connectRunStream({
    runId,
    api,
    store,
    wsBase,
    WebSocketImpl: WS_IMPL,
    heartbeatTimeoutMs: 0,
  });
}

// Cold-load the run the way a fresh browser session does: new store, replay-first.
// Returns the settled view plus the connection statuses the session observed.
async function coldLoad(
  api: ApiClient,
  runId: string,
  wsBase: string,
): Promise<{ view: RunView; statuses: RunStreamStatus[] }> {
  const store = createRunStore();
  const statuses: RunStreamStatus[] = [];
  socketConstructions = 0;
  const client = connectRunStream({
    runId,
    api,
    store,
    wsBase,
    WebSocketImpl: CountingWebSocket as unknown as WebSocketCtor,
    heartbeatTimeoutMs: 0,
    onStatusChange: (status) => statuses.push(status),
  });
  await waitFor(() => {
    const view = store.getState().runs[runId]?.view;
    return view != null && TERMINAL.has(view.run.status);
  });
  // Give a wrongly-scheduled socket attach every chance to happen before asserting.
  await sleep(100);
  expect(socketConstructions).toBe(0);
  expect(statuses).not.toContain('open');
  expect(client.getStatus()).toBe('closed');
  const view = store.getState().runs[runId]!.view!;
  client.close();
  return { view, statuses };
}

describe('run history: terminal runs replay over HTTP with no WebSocket (T5.2/D5)', () => {
  it('failed run: a cold session deep-equals the live session, with zero sockets', async () => {
    const api = createApiClient(failRunner.url);
    const wsBase = failRunner.url.replace('http://', 'ws://');
    const { runId } = await api.createRun({ taskPrompt: 'bring up BME280', boardProfileId: BOARD });

    // Live session: watch over WS, approving every gate; the fail variant's second
    // iteration fails its checks again and the run ends in run.failed.
    const storeA = createRunStore();
    const clientA = liveConnect(api, runId, storeA, wsBase);
    const resolved = new Set<string>();
    await waitFor(() => {
      const view = storeA.getState().runs[runId]?.view;
      if (!view) return false;
      if (view.run.status === 'plan_ready' && !resolved.has('__plan__')) {
        resolved.add('__plan__');
        void api.approvePlan(runId);
      }
      const pending = view.approvals.find((a) => a.status === 'pending');
      if (pending && !resolved.has(pending.id)) {
        resolved.add(pending.id);
        void api.resolveApproval(runId, pending.id, 'approved');
      }
      return view.run.status === 'failed';
    });
    const liveView = storeA.getState().runs[runId]!.view!;
    expect(liveView.endedAt).toBeDefined();
    // The live client detached its socket at the terminal event — from here on this
    // session behaves exactly like history (no idle socket, no reconnect loop).
    await waitFor(() => clientA.getStatus() === 'closed');
    clientA.close();

    // Fresh session, cold URL: HTTP replay only.
    const { view: coldView } = await coldLoad(api, runId, wsBase);
    expect(coldView.run.status).toBe('failed');
    expect(coldView).toEqual(liveView);
  }, 40000);

  it('stopped run: a cold session deep-equals the live session, with zero sockets', async () => {
    const api = createApiClient(runner.url);
    const wsBase = runner.url.replace('http://', 'ws://');
    const { runId } = await api.createRun({ taskPrompt: 'bring up BME280', boardProfileId: BOARD });

    // Live session: approve the plan, then stop the run at the flash-approval gate —
    // a deterministic mid-run point, exactly how a user aborts.
    const storeA = createRunStore();
    const clientA = liveConnect(api, runId, storeA, wsBase);
    await waitFor(() => storeA.getState().runs[runId]?.view?.run.status === 'plan_ready');
    await api.approvePlan(runId);
    await waitFor(
      () => storeA.getState().runs[runId]?.view?.approvals.some((a) => a.status === 'pending') ?? false,
    );
    await api.stopRun(runId);
    await waitFor(() => storeA.getState().runs[runId]?.view?.run.status === 'stopped');
    const liveView = storeA.getState().runs[runId]!.view!;
    expect(liveView.endedAt).toBeDefined();
    await waitFor(() => clientA.getStatus() === 'closed');
    clientA.close();

    const { view: coldView } = await coldLoad(api, runId, wsBase);
    expect(coldView.run.status).toBe('stopped');
    expect(coldView).toEqual(liveView);
  }, 40000);
});
