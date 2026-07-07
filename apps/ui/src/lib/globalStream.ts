// A single shared subscription to the runner's global WS stream (BIBLE §5.3): a
// runner.status snapshot on connect, then run.created + run.status_changed for every
// run. The socket opens on the first subscriber and closes when the last leaves, so the
// whole app rides one global connection no matter how many surfaces listen — the top
// bar's runner pill (bench snapshot) and the Home list's live run updates both do.
import { useEffect, useRef } from 'react';
import type { Event } from '@boardex/contract';
import { RUNNER_WS_BASE } from './config';
import { WsClient } from './ws';

export type GlobalListener = (event: Event) => void;

const listeners = new Set<GlobalListener>();
let client: WsClient | null = null;

function ensureClient(): void {
  if (client) return;
  client = new WsClient({
    wsBase: RUNNER_WS_BASE,
    target: { kind: 'global' },
    // Snapshot the set: a listener that unsubscribes mid-dispatch must not perturb the
    // iteration (and the global stream is forward-compatible — unknown types dropped
    // upstream in WsClient, §5.1).
    onEvent: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
  });
  client.connect();
}

export function subscribeGlobal(listener: GlobalListener): () => void {
  listeners.add(listener);
  ensureClient();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && client) {
      client.close();
      client = null;
    }
  };
}

// Subscribe a component to the global stream for its lifetime. The latest callback is
// held in a ref so a changing handler identity never re-subscribes (which would churn
// the socket); the effect runs once per mount.
export function useGlobalEvents(onEvent: GlobalListener): void {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => subscribeGlobal((event) => ref.current(event)), []);
}
