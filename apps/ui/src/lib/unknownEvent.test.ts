// Mutation-style coverage for audit F1 (§5.1 forward compatibility, T5.0): an
// unknown event type injected mid-stream — the exact thing a newer runner will one
// day emit — must cost the UI nothing. Before the envelope-first fix, the unknown
// frame was dropped, the store's gapless prefix parked at the hole, the view froze,
// and every reconnect replay re-parsed the same log into the same failure: a
// reconnect loop. This file drives the REAL client/store path (connectRunStream →
// WsClient → runStore → reduceRun) over both arrival routes:
//   1. live over the WebSocket, and
//   2. in the HTTP replay body (parsed with the real GetRunEventsResponseSchema,
//      exactly as lib/api.ts parses it — a page reload's recovery path).
import { describe, expect, it } from 'vitest';
import { GetRunEventsResponseSchema, type Run, type WireEvent } from '@boardex/contract';
import { createRunStore } from './runStore';
import { connectRunStream, type RunStreamStatus } from './runStream';
import type { WebSocketCtor, WebSocketLike } from './ws';

const RUN_ID = 'run_unknown_f1';
const at = (s: number): string => `2026-07-07T14:00:0${s}.000Z`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const run: Run = {
  id: RUN_ID,
  title: 'BME280 bring-up',
  taskPrompt: 'bring up',
  boardProfileId: 'bp_1',
  status: 'planning',
  createdAt: at(0),
  updatedAt: at(0),
  iteration: 1,
};

// The doctored stream: a §5.2 catalog stream with one unknown-typed event spliced
// into the middle, exactly where seq continuity would break if it were dropped.
const rawEvents: unknown[] = [
  { seq: 1, runId: RUN_ID, ts: at(0), type: 'run.created', payload: { run } },
  { seq: 2, runId: RUN_ID, ts: at(1), type: 'run.status_changed', payload: { status: 'plan_ready' } },
  // Not in the catalog; payload shape entirely its own.
  { seq: 3, runId: RUN_ID, ts: at(2), type: 'run.checkpoint', payload: { blob: 'x' } },
  { seq: 4, runId: RUN_ID, ts: at(3), type: 'run.status_changed', payload: { status: 'running' } },
];

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  fireOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  fireMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}
const FakeCtor = FakeSocket as unknown as WebSocketCtor;

// The replay seam mirrors lib/api.ts getRunEvents verbatim: the raw JSON body is
// parsed with the contract's (envelope-first) response schema.
function replayApi(body: () => unknown[]) {
  return {
    getRunEvents: (_runId: string, afterSeq = 0): Promise<WireEvent[]> =>
      Promise.resolve(
        GetRunEventsResponseSchema.parse(body()).filter((event) => event.seq > afterSeq),
      ),
  };
}

async function settle(): Promise<void> {
  await sleep(10);
}

// T5.2 made the load replay-first: connectRunStream now attaches the socket only
// AFTER the primary HTTP replay resolves (and only because these streams are
// non-terminal), so the socket exists a microtask later, not synchronously.
async function socketAttached(): Promise<FakeSocket> {
  for (let waited = 0; waited < 1000; waited += 5) {
    const socket = FakeSocket.instances[0];
    if (socket) return socket;
    await sleep(5);
  }
  throw new Error('socket was never constructed');
}

describe('unknown event mid-stream (audit F1 mutation)', () => {
  it('live over WS: the view stays live past the unknown seq, with no reconnect', async () => {
    FakeSocket.instances = [];
    const store = createRunStore();
    const statuses: RunStreamStatus[] = [];
    const client = connectRunStream({
      runId: RUN_ID,
      api: replayApi(() => []),
      store,
      wsBase: 'ws://runner',
      WebSocketImpl: FakeCtor,
      heartbeatTimeoutMs: 0,
      onStatusChange: (status) => statuses.push(status),
    });
    const socket = await socketAttached();
    socket.fireOpen();
    await settle(); // let the (empty) handshake replay flush

    for (const event of rawEvents) socket.fireMessage(JSON.stringify(event));

    const view = store.getState().runs[RUN_ID]?.view;
    expect(view).not.toBeNull();
    // The event AFTER the unknown one landed: the view is live, not parked at seq 2.
    expect(view?.lastSeq).toBe(4);
    expect(view?.run.status).toBe('running');
    expect(view?.warnings).toEqual([]);

    // No reconnect loop: one socket, never a 'reconnecting' transition.
    expect(FakeSocket.instances).toHaveLength(1);
    expect(statuses).not.toContain('reconnecting');
    expect(client.getStatus()).toBe('open');
    client.close();
  });

  it('in replay: a reload recovers the identical view from the doctored log', async () => {
    FakeSocket.instances = [];
    const store = createRunStore();
    const statuses: RunStreamStatus[] = [];
    const client = connectRunStream({
      runId: RUN_ID,
      api: replayApi(() => rawEvents),
      store,
      wsBase: 'ws://runner',
      WebSocketImpl: FakeCtor,
      heartbeatTimeoutMs: 0,
      onStatusChange: (status) => statuses.push(status),
    });
    (await socketAttached()).fireOpen();
    await settle();

    const view = store.getState().runs[RUN_ID]?.view;
    expect(view?.lastSeq).toBe(4);
    expect(view?.run.status).toBe('running');
    expect(view?.warnings).toEqual([]);
    expect(statuses).not.toContain('reconnecting');
    expect(client.getStatus()).toBe('open');
    client.close();
  });

  it('replay and live arrival reduce to the same state (reload ≡ having watched)', async () => {
    // Same doctored bytes down both routes; the store must not care which one
    // delivered them.
    const liveStore = createRunStore();
    for (const event of GetRunEventsResponseSchema.parse(rawEvents)) {
      liveStore.getState().ingest(RUN_ID, event);
    }
    const reloadStore = createRunStore();
    reloadStore.getState().ingestMany(RUN_ID, GetRunEventsResponseSchema.parse(rawEvents));

    const a = liveStore.getState().runs[RUN_ID]?.view;
    const b = reloadStore.getState().runs[RUN_ID]?.view;
    expect(a).not.toBeNull();
    expect(b?.lastSeq).toBe(a?.lastSeq);
    expect(b?.run).toEqual(a?.run);
  });
});
