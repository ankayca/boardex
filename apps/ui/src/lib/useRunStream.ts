// Subscribe a component to one run's event stream for its lifetime (BIBLE D5):
// connectRunStream wires live WS events plus HTTP replay-from-lastSeq into the run
// store, and the socket closes when the component unmounts. Store entries are kept
// across unmounts — events are immutable and the store dedupes by seq, so remounting
// simply replays the delta.
//
// Returns the live WS connection status so the workspace can raise the amber
// reconnecting bar on a drop (§7.3). The callback is gated on the effect's lifetime,
// so the teardown's own 'closed' transition never lands on an unmounted component.
import { useEffect, useState } from 'react';
import { api } from './api';
import { useRunStore } from './runStore';
import { connectRunStream } from './runStream';
import type { WsConnectionStatus } from './ws';

export function useRunStream(runId: string | undefined): WsConnectionStatus {
  const [status, setStatus] = useState<WsConnectionStatus>('connecting');
  useEffect(() => {
    if (!runId) return;
    let active = true;
    const client = connectRunStream({
      runId,
      api,
      store: useRunStore,
      onStatusChange: (next) => {
        if (active) setStatus(next);
      },
    });
    return () => {
      active = false;
      client.close();
    };
  }, [runId]);
  return status;
}
