// @vitest-environment node
//
// Reconnect hardening (T2.3, BIBLE §7.3): a mid-run WS drop must self-heal with no
// data loss and drive the exact connection-state transitions the amber reconnecting
// bar renders. Against a live mock runner: stream to a mid-run gate, drop the socket
// (the client's test seam, same code path as a real network drop), and assert the
// status goes open → reconnecting → open while the same store HTTP-replays from its
// lastSeq. The run then plays out to completion with no gaps and no warnings —
// identical RunView, the reducer lastSeq path proven end-to-end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import { reduceRun } from '@boardex/contract';
import { createApiClient, type ApiClient } from '../../lib/api';
import { connectRunStream } from '../../lib/runStream';
import { createRunStore, type RunStore } from '../../lib/runStore';
import type { WebSocketCtor, WsConnectionStatus } from '../../lib/ws';

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

describe('workspace reconnect mid-run (ws drop → reconnect → replay)', () => {
  it('recovers a dropped socket with no data loss and drives the bar status open → reconnecting → open', async () => {
    const store: RunStore = createRunStore();
    const statuses: WsConnectionStatus[] = [];
    const { runId } = await api.createRun({ taskPrompt: 'bring up BME280', boardProfileId: BOARD });

    const client = connectRunStream({
      runId,
      api,
      store,
      wsBase,
      WebSocketImpl: WS_IMPL,
      heartbeatTimeoutMs: 0,
      onStatusChange: (s) => statuses.push(s),
    });

    // Stream to the flash-approval gate — a stable mid-run point.
    await waitFor(() => store.getState().runs[runId]?.view?.run.status === 'plan_ready');
    await api.approvePlan(runId);
    await waitFor(
      () => store.getState().runs[runId]?.view?.approvals.some((a) => a.status === 'pending') ?? false,
    );
    const seqAtDrop = store.getState().runs[runId]!.view!.lastSeq;
    expect(statuses).toContain('open');

    // Drop the live socket. onClose → reconnect → HTTP replay from lastSeq → resume.
    client.simulateDrop();
    await waitFor(() => statuses.includes('reconnecting'));
    await waitFor(() => client.getStatus() === 'open');

    // The bar's exact lifecycle: an 'open', then 'reconnecting', then 'open' again.
    const firstOpen = statuses.indexOf('open');
    const reconnecting = statuses.indexOf('reconnecting', firstOpen + 1);
    expect(reconnecting).toBeGreaterThan(firstOpen);
    expect(statuses.indexOf('open', reconnecting + 1)).toBeGreaterThan(reconnecting);

    // No data lost across the drop: the reduced view never regressed below the drop seq.
    expect(store.getState().runs[runId]!.view!.lastSeq).toBeGreaterThanOrEqual(seqAtDrop);

    // The reconnected session plays the fixture out; resolve every remaining approval.
    const resolved = new Set<string>();
    await waitFor(() => {
      const view = store.getState().runs[runId]?.view;
      if (!view) return false;
      const pending = view.approvals.find((a) => a.status === 'pending');
      if (pending && !resolved.has(pending.id)) {
        resolved.add(pending.id);
        void api.resolveApproval(runId, pending.id, 'approved');
      }
      return view.run.status === 'completed';
    });

    // Fast-fail spot checks first, so a broken run reports what broke…
    const finalView = store.getState().runs[runId]!.view!;
    expect(finalView.lastSeq).toBe(90);
    expect(finalView.warnings).toEqual([]);
    // Three checks, all passing at the end — exactly what the evidence band renders.
    expect(finalView.checks.map((c) => c.verdict)).toEqual(['pass', 'pass', 'pass']);

    // …then the byte-identical assertion (CLAUDE.md rule 5): reduce the runner's
    // full authoritative event log — the uninterrupted control stream — and deep-
    // equal the ENTIRE RunView against the view the interrupted session reduced:
    // run, steps, artifacts, checks, approvals, diagnosis, riskSummary, endedAt,
    // logsByStep (Map), iterations, lastSeq, warnings. Any event dropped, duplicated,
    // or reordered across the drop shows up here, not just in the spot fields.
    const controlEvents = await api.getRunEvents(runId, 0);
    expect(controlEvents).toHaveLength(90);
    expect(finalView).toEqual(reduceRun(controlEvents));

    client.close();
  }, 40000);
});
