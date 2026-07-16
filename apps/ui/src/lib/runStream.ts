// Replay-first run stream (BIBLE D5, §8 T5.2): loading a run starts with HTTP
// replay from the store's last contiguous seq — replay is the primary load path,
// not a side effect of a socket opening. If the replayed view is terminal the load
// is already complete: the event log of a terminal run can never grow, so no
// WebSocket is attempted at all (a runner may legitimately refuse sockets for
// archived runs). Only a non-terminal run attaches the live socket, which keeps
// its own reconnect + replay-from-lastSeq handshake (§5.4); and the moment the
// live stream delivers the terminal event, the socket is detached — the same
// invariant maintained over time: sockets exist only for runs that can still emit.
import { getRunnerWsBase } from './config';
import { ApiError, type ApiClient } from './api';
import type { RunStore } from './runStore';
import { isTerminalStatus } from './runStatus';
import { WsClient, type WebSocketCtor, type WsConnectionStatus } from './ws';

// The stream's own status vocabulary: the socket states, plus the fail-closed
// 'not_found' — GET /runs/{id}/events answered 404, the runner does not know this
// run (§5.3), and no amount of retrying changes a deterministic answer.
export type RunStreamStatus = WsConnectionStatus | 'not_found';

export interface ConnectRunStreamParams {
  runId: string;
  api: Pick<ApiClient, 'getRunEvents'>;
  store: RunStore;
  wsBase?: string;
  WebSocketImpl?: WebSocketCtor;
  heartbeatTimeoutMs?: number;
  onStatusChange?: (status: RunStreamStatus) => void;
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
  private status: RunStreamStatus = 'closed';
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

  getStatus(): RunStreamStatus {
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
    } catch (error) {
      if (this.disposed) return;
      // Error classes differ (T5.2 review F2): a 404 is a deterministic answer —
      // the runner does not know this run id (§5.3) — so the stream fails closed
      // as 'not_found': no retry loop, no socket, and the route renders an honest
      // not-found state instead of an amber bar. Network errors and 5xx are
      // transient runner trouble and keep the backoff + 'reconnecting' treatment.
      if (error instanceof ApiError && error.status === 404) {
        this.setStatus('not_found');
        return;
      }
      // A terminal view never surfaces 'reconnecting' (F1's invariant): whatever
      // the store already holds is terminal-correct, so settle instead of retrying
      // a replay that could only fetch an already-ended run's tail best-effort.
      if (this.isTerminal()) {
        this.setStatus('closed');
        return;
      }
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
      wsBase: this.params.wsBase ?? getRunnerWsBase(),
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
      onStatusChange: (next) => {
        // Fallback release (T5.2 review F1): a stream that turned terminal via
        // run.status_changed alone — no dedicated terminal event, so the fast
        // detach above never fired — must not ride the reconnect loop. The moment
        // the socket would go 'reconnecting' (a drop, or the heartbeat cycling a
        // now-silent connection) while the view is terminal, release it instead:
        // one final HTTP replay catches any stranded tail, and the status settles
        // to 'closed'. A terminal view never surfaces 'reconnecting'.
        if (next === 'reconnecting' && this.isTerminal()) {
          this.releaseTerminalSocket();
          return;
        }
        this.setStatus(next);
      },
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

  // F1: detach a terminal run's socket without reconnecting, then fetch the log's
  // tail once over HTTP — e.g. a dedicated terminal event that was still in flight
  // when the socket dropped — so the stored view converges on the full log.
  private releaseTerminalSocket(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close(); // also cancels the reconnect the inner client just scheduled
    void this.finalReplay();
  }

  private async finalReplay(): Promise<void> {
    const { runId, api, store } = this.params;
    try {
      const events = await api.getRunEvents(runId, store.getState().lastContiguousSeq(runId));
      if (this.disposed) return;
      store.getState().ingestMany(runId, events);
    } catch {
      // Best effort: the view is already terminal-correct, and a failed tail
      // fetch must not resurrect a connection for a finished run.
    }
    this.setStatus('closed');
  }

  private setStatus(next: RunStreamStatus): void {
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
