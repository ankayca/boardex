// Wires a run's WebSocket stream to the run store (BIBLE §5.4/D5): live events are
// ingested as they arrive, and on every (re)connect the client HTTP-replays from the
// store's last contiguous seq so no event is missed across a drop.
import { RUNNER_WS_BASE } from './config';
import type { ApiClient } from './api';
import type { RunStore } from './runStore';
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

export function connectRunStream(params: ConnectRunStreamParams): WsClient {
  const { runId, api, store } = params;
  const client = new WsClient({
    wsBase: params.wsBase ?? RUNNER_WS_BASE,
    target: { kind: 'run', runId },
    onEvent: (event) => store.getState().ingest(runId, event),
    fetchReplay: () => api.getRunEvents(runId, store.getState().lastContiguousSeq(runId)),
    WebSocketImpl: params.WebSocketImpl,
    heartbeatTimeoutMs: params.heartbeatTimeoutMs,
    onStatusChange: params.onStatusChange,
  });
  client.connect();
  return client;
}
