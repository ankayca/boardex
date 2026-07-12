// Replay-first run stream (BIBLE D5, §8 T5.2): loading a run starts with HTTP
// replay from the store's last contiguous seq — replay is the primary load path,
// not a side effect of a socket opening. If the replayed view is terminal the load
// is already complete: the event log of a terminal run can never grow, so no
// WebSocket is attempted at all (a runner may legitimately refuse sockets for
// archived runs). Only a non-terminal run attaches the live socket, which keeps
// its own reconnect + replay-from-lastSeq handshake (§5.4); and the moment the
// live stream delivers the terminal event, the socket is detached — the same
// invariant maintained over time: sockets exist only for runs that can still emit.
import { RUNNER_WS_BASE } from './config';
import type { ApiClient } from './api';
import type { RunStore } from './runStore';
import { isTerminalStatus } from './runStatus';
import { WsClient, type WebSocketCtor, type WsConnectionStatus } from './ws';

export interface ConnectRunStreamParams {
  runId: string;
  api: Pick<ApiClient, 'getRunEvents'>;
  store: RunStore;
  wsBase?: string;
  WebSocketImpl?: WebSocketCtor;
  heartbeatTimeoutMs?: number;
  onStatusChange?: (status: WsConnectionStatus) => void;
}

// Retry pacing for the primary replay, mirroring WsClient's reconnect backoff so a
// dead runner surfaces the same way on both load paths: 'reconnecting' + retries.
const REPLAY_BACKOFF = { baseMs: 300, maxMs: 5000 };

// The dedicated terminal events (§5.3 v2.0) — always the last event of a run's log.
const DEDICATED_TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.stopped']);
const isDedicatedTerminalEvent = (type: string): boolean => DEDICATED_TERMINAL_EVENTS.has(type);

export class RunStreamClient {
  private readonly params: ConnectRunStreamParams;
  private ws: WsClient | null = null;
  private status: WsConnectionStatus = 'closed';
  private disposed = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(params: ConnectRunStreamParams) {
    this.params = params;
  }

  connect(): void {
    if (this.disposed) return;
    this.setStatus('connecting');
    void this.load();
  }

  close(): void {
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setStatus('closed');
  }

  getStatus(): WsConnectionStatus {
    return this.status;
  }

  // Test seam (same contract as WsClient's): simulate a network drop of the live
  // socket. A terminal run holds no socket, so there is nothing to drop.
  simulateDrop(): void {
    this.ws?.simulateDrop();
  }

  private isTerminal(): boolean {
    const view = this.params.store.getState().runs[this.params.runId]?.view;
    return view != null && isTerminalStatus(view.run.status);
  }

  // The primary load path: HTTP replay from the store's last contiguous seq, then
  // — only if the reduced view is still non-terminal — the live socket.
  private async load(): Promise<void> {
    const { runId, api, store } = this.params;
    let events;
    try {
      events = await api.getRunEvents(runId, store.getState().lastContiguousSeq(runId));
    } catch {
      if (this.disposed) return;
      this.setStatus('reconnecting');
      const exp = Math.min(REPLAY_BACKOFF.maxMs, REPLAY_BACKOFF.baseMs * 2 ** this.attempt);
      this.attempt++;
      // Full jitter, matching WsClient, so parallel clients don't retry in lockstep.
      const delay = exp / 2 + Math.random() * (exp / 2);
      this.retryTimer = setTimeout(() => void this.load(), delay);
      return;
    }
    if (this.disposed) return;
    this.attempt = 0;
    store.getState().ingestMany(runId, events);
    if (this.isTerminal()) {
      // The run's history IS its state (D5): the replay rendered everything there
      // will ever be. No socket is constructed.
      this.setStatus('closed');
      return;
    }
    this.attachSocket();
  }

  private attachSocket(): void {
    const { runId, api, store } = this.params;
    this.ws = new WsClient({
      wsBase: this.params.wsBase ?? RUNNER_WS_BASE,
      target: { kind: 'run', runId },
      onEvent: (event) => {
        store.getState().ingest(runId, event);
        // The live stream delivered the run's DEDICATED terminal event (§5.3 v2.0)
        // and the reduced view confirms it landed in the contiguous prefix: the
        // log is complete, so the socket has nothing left to carry. Detach instead
        // of idling into the heartbeat/reconnect loop against a runner that may
        // refuse sockets for archived runs. Keying on the dedicated event — not on
        // the view's status alone — matters: a run.status_changed carrying a
        // terminal status legally precedes run.stopped (the mock's stop path does
        // exactly this), and detaching there would strand the log's last event.
        if (isDedicatedTerminalEvent(event.type) && this.isTerminal()) this.detachSocket();
      },
      fetchReplay: () => api.getRunEvents(runId, store.getState().lastContiguousSeq(runId)),
      WebSocketImpl: this.params.WebSocketImpl,
      heartbeatTimeoutMs: this.params.heartbeatTimeoutMs,
      onStatusChange: (next) => this.setStatus(next),
    });
    this.ws.connect();
  }

  private detachSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.close(); // its own 'closed' arrives via onStatusChange; setStatus dedupes
    this.setStatus('closed');
  }

  private setStatus(next: WsConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.params.onStatusChange?.(next);
  }
}

export function connectRunStream(params: ConnectRunStreamParams): RunStreamClient {
  const client = new RunStreamClient(params);
  client.connect();
  return client;
}
