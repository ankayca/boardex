// Subscribe a component to one run's event stream for its lifetime (BIBLE D5):
// connectRunStream wires live WS events plus HTTP replay-from-lastSeq into the run
// store, and the socket closes when the component unmounts. Store entries are kept
// across unmounts — events are immutable and the store dedupes by seq, so remounting
// simply replays the delta.
//
// Returns the live WS connection status so the workspace can raise the amber
// reconnecting bar on a drop (§7.3). Status is keyed by runId and reset to
// 'connecting' synchronously — during render, before commit — when runId changes,
// so no frame ever paints the previous run's connection state. The callback is
// additionally gated on the effect's lifetime, so a stale client's transitions
// (including the teardown's own 'closed') never land after the switch.
import { useEffect, useState } from 'react';
import { api } from './api';
import { useRunStore } from './runStore';
import { connectRunStream } from './runStream';
import type { WsConnectionStatus } from './ws';

interface StreamStatus {
  runId: string | undefined;
  status: WsConnectionStatus;
}

export function useRunStream(runId: string | undefined): WsConnectionStatus {
  const [state, setState] = useState<StreamStatus>({ runId, status: 'connecting' });
  // Derived-state reset in render: React re-renders with the fresh state before
  // committing, so the stale status is discarded without ever painting.
  if (state.runId !== runId) {
    setState({ runId, status: 'connecting' });
  }

  useEffect(() => {
    if (!runId) return;
    let active = true;
    const client = connectRunStream({
      runId,
      api,
      store: useRunStore,
      onStatusChange: (next) => {
        if (active) setState({ runId, status: next });
      },
    });
    return () => {
      active = false;
      client.close();
    };
  }, [runId]);

  return state.runId === runId ? state.status : 'connecting';
}
