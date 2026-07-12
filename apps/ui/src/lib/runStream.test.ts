// The replay-first stream client (T5.2, BIBLE D5): a terminal run loads entirely
// from HTTP replay and NEVER constructs a WebSocket — asserted by spying on the
// socket constructor — while a non-terminal run attaches the socket only after the
// primary replay landed, and detaches it the moment the live stream turns terminal.
// A failed primary replay retries with 'reconnecting', mirroring a socket outage.
import { describe, expect, it, vi } from 'vitest';
import type { Event, Run, WireEvent } from '@boardex/contract';
import { createRunStore } from './runStore';
import { connectRunStream } from './runStream';
import type { WebSocketCtor, WebSocketLike, WsConnectionStatus } from './ws';

const RUN_ID = 'run_hist';
const TS = '2026-07-10T12:00:00.000Z';

const run: Run = {
  id: RUN_ID,
  title: 'Bring up BME280',
  taskPrompt: 'Bring up the BME280 sensor over I2C.',
  boardProfileId: 'bp_nucleo_f303re',
  status: 'planning',
  createdAt: TS,
  updatedAt: TS,
  iteration: 1,
};

type Payload<T extends Event['type']> = Extract<Event, { type: T }>['payload'];
function envelope<T extends Event['type']>(seq: number, type: T, payload: Payload<T>): Event {
  return { seq, runId: RUN_ID, ts: TS, type, payload } as Event;
}

const created = envelope(1, 'run.created', { run });
const failed = envelope(2, 'run.failed', { summary: 'checks failed twice' });

// Serves `events` the way GET /runs/{id}/events?afterSeq= does.
function fakeApi(events: () => WireEvent[]) {
  return {
    getRunEvents: vi.fn((_runId: string, afterSeq = 0) =>
      Promise.resolve(events().filter((event) => event.seq > afterSeq)),
    ),
  };
}

// Minimal WebSocketLike whose constructor is the spy under test.
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readonly url: string;
  readyState = 0;
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 5) {
    if (pred()) return;
    await sleep(5);
  }
  throw new Error('timeout waiting for condition');
}

function connect(api: ReturnType<typeof fakeApi>, statuses: WsConnectionStatus[]) {
  const store = createRunStore();
  const client = connectRunStream({
    runId: RUN_ID,
    api,
    store,
    wsBase: 'ws://mock',
    WebSocketImpl: FakeSocket as unknown as WebSocketCtor,
    heartbeatTimeoutMs: 0,
    onStatusChange: (status) => statuses.push(status),
  });
  return { store, client };
}

describe('connectRunStream (replay-first, T5.2)', () => {
  it('renders a terminal run from HTTP replay alone — the socket constructor is never called', async () => {
    FakeSocket.instances = [];
    const api = fakeApi(() => [created, failed]);
    const statuses: WsConnectionStatus[] = [];
    const { store, client } = connect(api, statuses);

    await waitFor(() => store.getState().runs[RUN_ID]?.view?.run.status === 'failed');
    // Settled: the load path has fully resolved and decided against a socket.
    await sleep(20);

    expect(FakeSocket.instances).toHaveLength(0);
    expect(api.getRunEvents).toHaveBeenCalledWith(RUN_ID, 0);
    expect(client.getStatus()).toBe('closed');
    expect(statuses).toEqual(['connecting', 'closed']);
    expect(store.getState().runs[RUN_ID]?.view?.endedAt).toBe(TS);
    client.close();
  });

  it('attaches the socket for a non-terminal run only after the primary replay landed', async () => {
    FakeSocket.instances = [];
    let eventsInStoreAtConstruction = -1;
    const api = fakeApi(() => [created]);
    const store = createRunStore();
    class ObservingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        eventsInStoreAtConstruction = store.getState().runs[RUN_ID]?.events.length ?? 0;
      }
    }
    const client = connectRunStream({
      runId: RUN_ID,
      api,
      store,
      wsBase: 'ws://mock',
      WebSocketImpl: ObservingSocket as unknown as WebSocketCtor,
      heartbeatTimeoutMs: 0,
    });

    await waitFor(() => FakeSocket.instances.length === 1);
    // Replay-first: by the time the socket exists, the store already holds the replay.
    expect(eventsInStoreAtConstruction).toBe(1);
    expect(FakeSocket.instances[0]!.url).toBe(`ws://mock/ws?runId=${RUN_ID}`);
    client.close();
    expect(FakeSocket.instances[0]!.closed).toBe(true);
  });

  it('detaches the socket the moment the live stream turns terminal', async () => {
    FakeSocket.instances = [];
    const wire: WireEvent[] = [created];
    const api = fakeApi(() => wire);
    const statuses: WsConnectionStatus[] = [];
    const { store, client } = connect(api, statuses);

    await waitFor(() => FakeSocket.instances.length === 1);
    const socket = FakeSocket.instances[0]!;
    socket.readyState = 1;
    socket.onopen?.({});
    await waitFor(() => statuses.includes('open'));

    // The terminal event arrives live over the socket.
    wire.push(failed);
    socket.onmessage?.({ data: JSON.stringify(failed) });
    await waitFor(() => client.getStatus() === 'closed');

    expect(socket.closed).toBe(true);
    expect(store.getState().runs[RUN_ID]?.view?.run.status).toBe('failed');
    // Detached, not dropped: no reconnect attempt follows (a second construction
    // would mean the client treated the detach as an outage).
    await sleep(50);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(statuses).not.toContain('reconnecting');
    client.close();
  });

  it("retries a failed primary replay with 'reconnecting', then completes the terminal load", async () => {
    FakeSocket.instances = [];
    let calls = 0;
    const api = {
      getRunEvents: vi.fn((_runId: string, afterSeq = 0) => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('runner unreachable'));
        return Promise.resolve([created, failed].filter((event) => event.seq > afterSeq));
      }),
    };
    const statuses: WsConnectionStatus[] = [];
    const { store, client } = connect(api, statuses);

    await waitFor(() => store.getState().runs[RUN_ID]?.view?.run.status === 'failed');
    expect(statuses).toEqual(['connecting', 'reconnecting', 'closed']);
    expect(FakeSocket.instances).toHaveLength(0);
    client.close();
  });
});
