import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Event } from '@boardex/contract';
import type { WebSocketCtor, WebSocketLike } from './ws';
import { subscribeGlobal } from './globalStream';

// A hand-driven WebSocket installed as the platform WebSocket. WsClient defaults its
// implementation to globalThis.WebSocket (undefined under jsdom), so this is how the
// shared global stream is exercised without touching production code.
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }

  fireMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const FakeCtor = FakeSocket as unknown as WebSocketCtor;
const globalRef = globalThis as { WebSocket?: WebSocketCtor };
const onlySocket = (): FakeSocket => {
  expect(FakeSocket.instances).toHaveLength(1);
  return FakeSocket.instances[0] as FakeSocket;
};

const statusChanged = (seq: number): string =>
  JSON.stringify({
    seq,
    runId: 'run_x',
    ts: '2026-07-07T14:00:00.000Z',
    type: 'run.status_changed',
    payload: { status: 'running' },
  } satisfies Event);

let originalWebSocket: WebSocketCtor | undefined;

beforeEach(() => {
  originalWebSocket = globalRef.WebSocket;
  globalRef.WebSocket = FakeCtor;
  FakeSocket.instances = [];
});

afterEach(() => {
  globalRef.WebSocket = originalWebSocket;
});

describe('globalStream (BIBLE §5.3 shared subscription)', () => {
  it('shares one socket across subscribers and closes it only when the last leaves', () => {
    const a: Event[] = [];
    const b: Event[] = [];

    // Two surfaces subscribe (e.g. Layout's runner pill + Home's live list).
    const unsubA = subscribeGlobal((event) => a.push(event));
    const unsubB = subscribeGlobal((event) => b.push(event));

    // Exactly one client/socket backs both subscribers.
    const socket = onlySocket();

    socket.fireMessage(statusChanged(1));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    // Dropping one subscriber keeps the socket open and the other still receives events.
    unsubA();
    expect(socket.closed).toBe(false);
    expect(FakeSocket.instances).toHaveLength(1); // no reconnect churn

    socket.fireMessage(statusChanged(2));
    expect(a).toHaveLength(1); // A stopped receiving
    expect(b).toHaveLength(2); // B still receiving over the same socket

    // Dropping the last subscriber closes the socket.
    unsubB();
    expect(socket.closed).toBe(true);
  });

  it('delivers to remaining listeners when one unsubscribes mid-dispatch (snapshot)', () => {
    const b: Event[] = [];
    let unsubB = (): void => {};

    // A, dispatched first, tears down B — a not-yet-visited listener. The snapshot in
    // onEvent must still deliver this event to B; a live-Set iteration would skip it.
    const unsubA = subscribeGlobal(() => unsubB());
    unsubB = subscribeGlobal((event) => b.push(event));

    const socket = onlySocket();
    socket.fireMessage(statusChanged(1));
    expect(b).toHaveLength(1); // B received the in-flight event despite being removed

    // The unsubscribe still took effect for subsequent events.
    socket.fireMessage(statusChanged(2));
    expect(b).toHaveLength(1);

    unsubA();
  });
});
