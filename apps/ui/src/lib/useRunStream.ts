// Subscribe a component to one run's event stream for its lifetime (BIBLE D5):
// connectRunStream loads the run replay-first over HTTP and attaches the live WS
// only while the run is non-terminal (T5.2 — a terminal run renders entirely from
// replay, no socket); everything closes when the component unmounts. Store entries
// are kept across unmounts — events are immutable and the store dedupes by seq, so
// remounting simply replays the delta.
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
import { connectRunStream, type RunStreamStatus } from './runStream';
import { useRunnerUrlVersion } from './settings';

interface StreamStatus {
  runId: string | undefined;
  status: RunStreamStatus;
}

export function useRunStream(runId: string | undefined): RunStreamStatus {
  // Reconnect the run socket when the runner URL changes at runtime (T6.6): keyed into
  // the effect deps so a URL swap tears down the old-base client and connects a fresh
  // one against the new base (replay is idempotent, so no data is lost or doubled).
  const urlVersion = useRunnerUrlVersion();
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
  }, [runId, urlVersion]);

  return state.runId === runId ? state.status : 'connecting';
}
