// WebSocket client for the event stream (BIBLE §5.3/§5.4). It connects per run
// (`/ws?runId=`) or globally (`/ws?global=1`), Zod-validates every inbound message,
// ignores unknown event types (§5.1 forward compatibility), auto-reconnects with
// backoff, runs a heartbeat/timeout watchdog, and — for run streams — replays the
// events the socket missed over HTTP before resuming live delivery (D5).
import { EventSchema, type Event } from '@boardex/contract';

// Structural WebSocket shape — satisfied by the browser WebSocket, Node's global
// WebSocket, and the `ws` package. Structural typing keeps this module free of the
// DOM `WebSocket` lib type so it typechecks in a node context too.
export interface WebSocketLike {
  readyState: number;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export type WsConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export type WsTarget = { kind: 'run'; runId: string } | { kind: 'global' };

export interface WsClientOptions {
  wsBase: string;
  target: WsTarget;
  onEvent: (event: Event) => void;
  // Run targets only: fetch the events after the caller's last-known contiguous seq,
  // fed through onEvent on every (re)connect before live events resume. Omit for the
  // global stream (the runner re-sends a runner.status snapshot on connect).
  fetchReplay?: () => Promise<Event[]>;
  onStatusChange?: (status: WsConnectionStatus) => void;
  backoff?: { baseMs?: number; maxMs?: number };
  // Silence longer than this cycles the socket, defending against a silently dead
  // connection that never fires `close`. Reconnect is idempotent (replay dedupes),
  // so a false positive during a legitimate pause is harmless. 0 disables it.
  heartbeatTimeoutMs?: number;
  // Injectable for tests / non-DOM hosts; defaults to the platform WebSocket.
  WebSocketImpl?: WebSocketCtor;
}

const DEFAULT_BACKOFF = { baseMs: 300, maxMs: 5000 };
const DEFAULT_HEARTBEAT_MS = 30000;

// Parse one inbound frame. Known events are returned; a well-formed envelope with an
// unknown type (or any malformed frame) is dropped, never thrown (§5.1).
function parseEvent(raw: unknown): Event | null {
  let json: unknown;
  try {
    json = JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch {
    return null;
  }
  const parsed = EventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export class WsClient {
  private readonly options: WsClientOptions;
  private readonly Ctor: WebSocketCtor | undefined;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly heartbeatMs: number;

  private ws: WebSocketLike | null = null;
  private status: WsConnectionStatus = 'closed';
  private attempt = 0;
  private disposed = false;
  private replayInFlight = false;
  private liveBuffer: Event[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: WsClientOptions) {
    this.options = options;
    this.Ctor = options.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.heartbeatMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_MS;
  }

  connect(): void {
    if (this.disposed) return;
    this.open();
  }

  close(): void {
    this.disposed = true;
    this.clearTimers();
    this.teardownSocket();
    this.setStatus('closed');
  }

  getStatus(): WsConnectionStatus {
    return this.status;
  }

  private url(): string {
    const base = this.options.wsBase.replace(/\/+$/, '');
    return this.options.target.kind === 'run'
      ? `${base}/ws?runId=${encodeURIComponent(this.options.target.runId)}`
      : `${base}/ws?global=1`;
  }

  private open(): void {
    if (this.disposed) return;
    if (!this.Ctor) {
      // No WebSocket implementation available (e.g. jsdom/SSR): stay closed, don't throw.
      this.setStatus('closed');
      return;
    }
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocketLike;
    try {
      ws = new this.Ctor(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => void this.onOpen();
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = () => this.onClose();
    ws.onerror = () => {
      // A close event follows an error; reconnection is driven from onClose.
    };
  }

  private async onOpen(): Promise<void> {
    if (this.disposed || !this.ws) return;
    this.attempt = 0;
    this.setStatus('open');
    this.armHeartbeat();

    if (this.options.target.kind !== 'run' || !this.options.fetchReplay) return;

    // Buffer any live events that land while the HTTP replay is in flight, then flush
    // them after — the store dedupes by seq, so overlap with the replay is a no-op.
    this.replayInFlight = true;
    this.liveBuffer = [];
    let replayed: Event[];
    try {
      replayed = await this.options.fetchReplay();
    } catch {
      // Replay failed; cycle the socket and retry the whole handshake to avoid a gap.
      this.replayInFlight = false;
      this.liveBuffer = [];
      this.cycleSocket();
      return;
    }
    if (this.disposed) return;
    for (const event of replayed) this.options.onEvent(event);
    const buffered = this.liveBuffer;
    this.liveBuffer = [];
    this.replayInFlight = false;
    for (const event of buffered) this.options.onEvent(event);
  }

  private onMessage(raw: unknown): void {
    this.armHeartbeat();
    const event = parseEvent(raw);
    if (!event) return;
    if (this.replayInFlight) {
      this.liveBuffer.push(event);
      return;
    }
    this.options.onEvent(event);
  }

  private onClose(): void {
    if (this.disposed) return;
    this.ws = null;
    this.clearHeartbeat();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.setStatus('reconnecting');
    const exp = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** this.attempt);
    this.attempt++;
    // Full jitter, so parallel clients don't reconnect in lockstep.
    const delay = exp / 2 + Math.random() * (exp / 2);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  // Force a reconnect: detach + close the current socket, then schedule a retry.
  private cycleSocket(): void {
    this.teardownSocket();
    this.scheduleReconnect();
  }

  private teardownSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.clearHeartbeat();
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // best effort
      }
    }
  }

  private armHeartbeat(): void {
    if (!this.heartbeatMs) return;
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => this.cycleSocket(), this.heartbeatMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private setStatus(status: WsConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  // Test seam: simulate an unexpected network drop of the live socket, exercising the
  // real reconnect + HTTP-replay path. Handlers stay attached so onClose drives it.
  simulateDrop(): void {
    const ws = this.ws;
    if (!ws) return;
    this.clearHeartbeat();
    try {
      ws.close();
    } catch {
      // best effort
    }
  }
}
