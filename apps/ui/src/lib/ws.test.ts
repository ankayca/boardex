import { afterEach, describe, expect, it } from 'vitest';
import {
  isKnownEvent,
  parseWireEvent,
  type Event,
  type Run,
  type RunStep,
  type WireEvent,
} from '@boardex/contract';
import { WsClient, type WebSocketCtor, type WebSocketLike, type WsConnectionStatus } from './ws';
import { createRunStore } from './runStore';

const at = (s: number): string => `2026-07-07T14:00:0${s}.000Z`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const flush = (): Promise<void> => sleep(5);

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 5) {
    if (pred()) return;
    await sleep(5);
  }
  throw new Error('timeout waiting for condition');
}

// A hand-driven WebSocket: the test fires open/message/close explicitly, so there is
// no timing dependence on a real socket. Satisfies the structural WebSocketLike shape.
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  private closed = false;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
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
const lastSocket = (): FakeSocket =>
  FakeSocket.instances[FakeSocket.instances.length - 1] as FakeSocket;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  FakeSocket.instances = [];
});

const runnerStatusEvent: Event = {
  seq: 1,
  runId: '_global',
  ts: at(0),
  type: 'runner.status',
  payload: {
    bench: { runnerOnline: true, contractVersion: 'boardex-contract/0.1', devices: [] },
  },
};

describe('WsClient', () => {
  it('parses envelope-first: unknown types arrive tagged ignored, non-envelopes drop (§5.1, T5.0/F1)', () => {
    const seen: WireEvent[] = [];
    const client = new WsClient({
      wsBase: 'ws://runner',
      target: { kind: 'global' },
      WebSocketImpl: FakeCtor,
      heartbeatTimeoutMs: 0,
      onEvent: (event) => seen.push(event),
    });
    client.connect();
    lastSocket().fireOpen();

    // (a) a well-formed envelope carrying a type outside the MVP catalog is
    // DELIVERED as an ignored envelope — its seq must reach the store, or the
    // gapless prefix parks forever (the F1 failure).
    lastSocket().fireMessage(
      JSON.stringify({ seq: 1, runId: '_global', ts: at(0), type: 'run.teleported', payload: {} }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0] && isKnownEvent(seen[0])).toBe(false);
    expect(seen[0]?.seq).toBe(1);

    // (b) a malformed (non-JSON) frame has no envelope and no seq: dropped, no throw.
    lastSocket().fireMessage('{ not valid json');
    expect(seen).toHaveLength(1);

    // A subsequent valid frame still dispatches normally, strictly typed.
    lastSocket().fireMessage(JSON.stringify(runnerStatusEvent));
    expect(seen).toHaveLength(2);
    expect(seen[1]?.type).toBe('runner.status');
    expect(seen[1] && isKnownEvent(seen[1])).toBe(true);

    client.close();
  });

  it('discards a stale onOpen continuation so it cannot flush or clear the newer handshake (epoch guard)', async () => {
    const RUN_ID = 'run_ws_epoch';
    const run: Run = {
      id: RUN_ID,
      title: 'BME280 bring-up',
      taskPrompt: 'bring up',
      boardProfileId: 'bp_1',
      status: 'running',
      createdAt: at(0),
      updatedAt: at(0),
      iteration: 1,
    };
    const step: RunStep = {
      id: 'step_1',
      runId: RUN_ID,
      planIndex: 0,
      kind: 'build',
      status: 'active',
      title: 'Build firmware',
      artifactIds: [],
    };
    const runEvents: Event[] = [
      { seq: 1, runId: RUN_ID, ts: at(0), type: 'run.created', payload: { run } },
      { seq: 2, runId: RUN_ID, ts: at(1), type: 'run.status_changed', payload: { status: 'running' } },
      { seq: 3, runId: RUN_ID, ts: at(2), type: 'step.started', payload: { step } },
    ];

    const store = createRunStore();
    const pending: Deferred<Event[]>[] = [deferred<Event[]>(), deferred<Event[]>()];
    let call = 0;

    const client = new WsClient({
      wsBase: 'ws://runner',
      target: { kind: 'run', runId: RUN_ID },
      WebSocketImpl: FakeCtor,
      heartbeatTimeoutMs: 0,
      backoff: { baseMs: 1, maxMs: 2 },
      onEvent: (event) => store.getState().ingest(RUN_ID, event),
      fetchReplay: () => (pending[call++] as Deferred<Event[]>).promise,
    });

    client.connect();
    const sockA = lastSocket();
    sockA.fireOpen(); // handshake #1: replay in flight, awaiting fetch #1

    // Sever socket A while its replay is still pending; onClose bumps the epoch and
    // schedules a reconnect that opens socket B (handshake #2).
    sockA.close();
    await waitUntil(() => FakeSocket.instances.length >= 2);
    const sockB = lastSocket();
    sockB.fireOpen(); // handshake #2: replay in flight, awaiting fetch #2

    // A live frame lands on B during its replay — it must be buffered, not dispatched.
    sockB.fireMessage(JSON.stringify(runEvents[2])); // seq 3

    // The STALE fetch #1 now resolves. The epoch guard must make it a no-op: it may
    // neither flush B's buffer nor clear it nor dispatch its own (abandoned) events.
    (pending[0] as Deferred<Event[]>).resolve([runEvents[0] as Event, runEvents[1] as Event]);
    await flush();
    // Nothing dispatched: the stale continuation ingested no events, so there is not
    // even a run entry yet (and B's replay is still pending).
    expect(store.getState().runs[RUN_ID]).toBeUndefined();

    // B's replay resolves: it dispatches its replay (1,2), then flushes the preserved
    // buffer (3). If the stale continuation had cleared the buffer, seq 3 would be lost.
    (pending[1] as Deferred<Event[]>).resolve([runEvents[0] as Event, runEvents[1] as Event]);
    await flush();
    const view = store.getState().runs[RUN_ID]?.view;
    expect(view?.lastSeq).toBe(3);
    expect(view?.steps).toHaveLength(1);

    client.close();
  });

  // T5.0 FIX_FIRST F1: an ignored envelope can legally hold seq 1 (§5.2 does not
  // promise run.created is first). Both delivery paths — HTTP replay and the live
  // socket — must carry it into the store without wedging the view.
  it('an ignored envelope at seq 1 flows through replay AND live delivery into a materialized view', async () => {
    const RUN_ID = 'run_ws_ignored_first';
    const run: Run = {
      id: RUN_ID,
      title: 'BME280 bring-up',
      taskPrompt: 'bring up',
      boardProfileId: 'bp_1',
      status: 'running',
      createdAt: at(0),
      updatedAt: at(0),
      iteration: 1,
    };
    // What the runner of the future sends: a type outside today's catalog, at seq 1.
    const unknownFirst = parseWireEvent({
      seq: 1,
      runId: RUN_ID,
      ts: at(0),
      type: 'run.preflight_checked',
      payload: { ok: true },
    }) as WireEvent;
    expect(isKnownEvent(unknownFirst)).toBe(false);
    const created: Event = { seq: 2, runId: RUN_ID, ts: at(1), type: 'run.created', payload: { run } };

    const store = createRunStore();
    const client = new WsClient({
      wsBase: 'ws://runner',
      target: { kind: 'run', runId: RUN_ID },
      WebSocketImpl: FakeCtor,
      heartbeatTimeoutMs: 0,
      onEvent: (event) => store.getState().ingest(RUN_ID, event),
      // Replay path: the HTTP replay body carries the ignored envelope (§5.1 —
      // an unknown-typed event must not fail the replay response).
      fetchReplay: () => Promise.resolve([unknownFirst]),
    });
    client.connect();
    lastSocket().fireOpen();
    await waitUntil(() => store.getState().lastContiguousSeq(RUN_ID) === 1);
    // Held, not thrown: the view is legitimately empty until run.created lands.
    expect(store.getState().runs[RUN_ID]?.view).toBeNull();
    expect(store.getState().runs[RUN_ID]?.reduceError).toBeNull();

    // Live path: run.created arrives over the socket and materializes the view.
    lastSocket().fireMessage(JSON.stringify(created));
    const view = store.getState().runs[RUN_ID]?.view;
    expect(view?.run.id).toBe(RUN_ID);
    expect(view?.lastSeq).toBe(2);

    client.close();
  });

  it('a throw during the replay flush cannot wedge the client: state resets and the handshake retries', async () => {
    const RUN_ID = 'run_ws_flush_throw';
    const run: Run = {
      id: RUN_ID,
      title: 'BME280 bring-up',
      taskPrompt: 'bring up',
      boardProfileId: 'bp_1',
      status: 'running',
      createdAt: at(0),
      updatedAt: at(0),
      iteration: 1,
    };
    const created: Event = { seq: 1, runId: RUN_ID, ts: at(0), type: 'run.created', payload: { run } };
    const running: Event = { seq: 2, runId: RUN_ID, ts: at(1), type: 'run.status_changed', payload: { status: 'running' } };

    const store = createRunStore();
    const statuses: WsConnectionStatus[] = [];
    let explodeOnce = true;
    const client = new WsClient({
      wsBase: 'ws://runner',
      target: { kind: 'run', runId: RUN_ID },
      WebSocketImpl: FakeCtor,
      heartbeatTimeoutMs: 0,
      backoff: { baseMs: 1, maxMs: 2 },
      onStatusChange: (status) => statuses.push(status),
      onEvent: (event) => {
        if (explodeOnce) {
          explodeOnce = false;
          throw new Error('handler exploded mid-flush');
        }
        store.getState().ingest(RUN_ID, event);
      },
      fetchReplay: () => Promise.resolve([created]),
    });

    client.connect();
    lastSocket().fireOpen();
    // Before the fix the throw escaped with replayInFlight stuck true: every later
    // live event was parked in the buffer forever and no reconnect was scheduled.
    // Now the failed flush surfaces as a connection error and cycles the socket.
    await waitUntil(() => FakeSocket.instances.length >= 2);
    expect(statuses).toContain('reconnecting');

    // The retried handshake replays from the store's cursor and recovers fully.
    lastSocket().fireOpen();
    await waitUntil(() => store.getState().runs[RUN_ID]?.view !== undefined && store.getState().runs[RUN_ID]?.view !== null);

    // Live delivery works again — nothing is stuck behind a stale replay buffer.
    lastSocket().fireMessage(JSON.stringify(running));
    expect(store.getState().runs[RUN_ID]?.view?.lastSeq).toBe(2);
    expect(store.getState().runs[RUN_ID]?.view?.run.status).toBe('running');

    client.close();
  });
});
