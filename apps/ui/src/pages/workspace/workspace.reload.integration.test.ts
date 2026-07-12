// @vitest-environment node
//
// Reload-mid-run acceptance (T2.1): a manual page reload throws the in-memory run
// store away, so the workspace's log panes are rebuilt purely from the reducer
// lastSeq path — a fresh store, HTTP replay from afterSeq=0, then live WS. Log
// content per step and per stream must be identical before and after the reload:
// no dropped lines, no duplicates. Driven against a live mock runner, paused at the
// flash-approval gate so before/after snapshots compare a quiescent stream exactly.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import type { RunView, StepLogStream } from '@boardex/contract';
import { createApiClient, type ApiClient } from '../../lib/api';
import { connectRunStream } from '../../lib/runStream';
import { createRunStore, type RunStore } from '../../lib/runStore';
import type { WebSocketCtor } from '../../lib/ws';

const WS_IMPL = WebSocket as unknown as WebSocketCtor;
const BOARD = 'bp_nucleo_f303re';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 20000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 10) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error('timeout waiting for condition');
}

// Materialize the per-step, per-stream log content of a view as plain data, so two
// stores can be compared exactly.
function logSnapshot(
  view: RunView,
): Record<string, { stream: StepLogStream; line: string; ts: string }[]> {
  const snapshot: Record<string, { stream: StepLogStream; line: string; ts: string }[]> = {};
  for (const [stepId, lines] of view.logsByStep) {
    snapshot[stepId] = lines.map((entry) => ({ ...entry }));
  }
  return snapshot;
}

let runner: MockRunner;
let api: ApiClient;
let wsBase: string;

beforeAll(async () => {
  runner = await createMockRunner({ port: 0, speed: 200 });
  api = createApiClient(runner.url);
  wsBase = runner.url.replace('http://', 'ws://');
});

afterAll(async () => {
  await runner.close();
});

function connect(runId: string, store: RunStore) {
  return connectRunStream({
    runId,
    api,
    store,
    wsBase,
    WebSocketImpl: WS_IMPL,
    heartbeatTimeoutMs: 0,
  });
}

describe('workspace reload mid-run (reducer lastSeq path)', () => {
  it('rebuilds identical per-stream log content in a fresh store after a reload', async () => {
    const { runId } = await api.createRun({ taskPrompt: 'bring up BME280', boardProfileId: BOARD });

    // "Before": stream into store A up to the flash-approval gate. The mock pauses
    // there, so A holds a stable mid-run state with context/edit/build logs on the
    // agent and build streams.
    const storeA = createRunStore();
    const clientA = connect(runId, storeA);
    await waitFor(() => storeA.getState().runs[runId]?.view?.run.status === 'plan_ready');
    await api.approvePlan(runId);
    await waitFor(
      () =>
        storeA.getState().runs[runId]?.view?.approvals.some((a) => a.status === 'pending') ??
        false,
    );

    const viewA = storeA.getState().runs[runId]!.view!;
    const before = logSnapshot(viewA);
    const seqAtReload = viewA.lastSeq;
    // Sanity: the gate really is mid-run, with log lines on more than one stream.
    expect(viewA.run.status).toBe('awaiting_approval');
    const streamsBefore = new Set(Object.values(before).flat().map((entry) => entry.stream));
    expect(streamsBefore.has('agent')).toBe(true);
    expect(streamsBefore.has('build')).toBe(true);

    // "Reload": the page's store is gone. A fresh store replays over HTTP from
    // afterSeq=0 and reduces to the same lastSeq.
    clientA.close();
    const storeB = createRunStore();
    const clientB = connect(runId, storeB);
    await waitFor(() => (storeB.getState().runs[runId]?.view?.lastSeq ?? 0) >= seqAtReload);

    const viewB = storeB.getState().runs[runId]!.view!;
    expect(viewB.lastSeq).toBe(seqAtReload);
    // Identical log content per step and per stream — nothing dropped, nothing doubled.
    expect(logSnapshot(viewB)).toEqual(before);

    // The reloaded session keeps working: resolve the gates and play the fixture out.
    const resolved = new Set<string>();
    await waitFor(() => {
      const view = storeB.getState().runs[runId]?.view;
      if (!view) return false;
      const pending = view.approvals.find((a) => a.status === 'pending');
      if (pending && !resolved.has(pending.id)) {
        resolved.add(pending.id);
        void api.resolveApproval(runId, pending.id, 'approved');
      }
      return view.run.status === 'completed';
    });

    const finalView = storeB.getState().runs[runId]!.view!;
    expect(finalView.lastSeq).toBe(90);
    expect(finalView.warnings).toEqual([]);
    // The full fixture routed lines onto four streams; every line kept its stream.
    const finalLines = [...finalView.logsByStep.values()].flat();
    const byStream = new Map<StepLogStream, number>();
    for (const { stream } of finalLines) byStream.set(stream, (byStream.get(stream) ?? 0) + 1);
    expect(byStream.get('agent')).toBeGreaterThan(0);
    expect(byStream.get('build')).toBeGreaterThan(0);
    expect(byStream.get('flash')).toBeGreaterThan(0);
    expect(byStream.get('serial')).toBeGreaterThan(0);

    clientB.close();
  }, 40000);
});
