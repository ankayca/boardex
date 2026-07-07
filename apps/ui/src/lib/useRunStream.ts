// Subscribe a component to one run's event stream for its lifetime (BIBLE D5):
// connectRunStream wires live WS events plus HTTP replay-from-lastSeq into the run
// store, and the socket closes when the component unmounts. Store entries are kept
// across unmounts — events are immutable and the store dedupes by seq, so remounting
// simply replays the delta.
import { useEffect } from 'react';
import { api } from './api';
import { useRunStore } from './runStore';
import { connectRunStream } from './runStream';

export function useRunStream(runId: string | undefined): void {
  useEffect(() => {
    if (!runId) return;
    const client = connectRunStream({ runId, api, store: useRunStore });
    return () => client.close();
  }, [runId]);
}
