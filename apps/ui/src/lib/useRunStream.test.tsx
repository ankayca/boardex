// useRunStream status keying (T2.3 review finding 3): on runId change the returned
// connection status resets to 'connecting' synchronously — the first committed frame
// for the new run never shows the previous run's state — and a stale client's late
// transitions can't clobber the new run's status. The stream client is mocked; the
// hook's state machine is what's under test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import type { WsConnectionStatus } from './ws';

interface FakeConnection {
  runId: string;
  onStatusChange?: (status: WsConnectionStatus) => void;
  close: () => void;
}
const connections: FakeConnection[] = [];

vi.mock('./runStream', () => ({
  connectRunStream: (params: {
    runId: string;
    onStatusChange?: (status: WsConnectionStatus) => void;
  }) => {
    const connection: FakeConnection = {
      runId: params.runId,
      onStatusChange: params.onStatusChange,
      close: vi.fn(),
    };
    connections.push(connection);
    return connection;
  },
}));

import { useRunStream } from './useRunStream';

// Records the status of every COMMITTED frame — a render-phase reset that repaints
// before commit leaves no trace here, which is exactly the guarantee under test.
function Probe({ runId, committed }: { runId: string; committed: WsConnectionStatus[] }) {
  const status = useRunStream(runId);
  useEffect(() => {
    committed.push(status);
  });
  return null;
}

afterEach(() => {
  cleanup();
  connections.length = 0;
});

describe('useRunStream status across runId changes', () => {
  it("resets to 'connecting' before the new run's first paint — never the previous run's last status", () => {
    const committed: WsConnectionStatus[] = [];
    const { rerender } = render(<Probe runId="run_a" committed={committed} />);
    expect(committed[0]).toBe('connecting');

    const connA = connections[0]!;
    act(() => connA.onStatusChange!('open'));
    act(() => connA.onStatusChange!('reconnecting'));
    expect(committed[committed.length - 1]).toBe('reconnecting');

    // Switch to run B: the first committed status must not be run A's 'reconnecting'.
    committed.length = 0;
    rerender(<Probe runId="run_b" committed={committed} />);
    expect(committed[0]).toBe('connecting');
    expect(committed).not.toContain('reconnecting');
    expect(connA.close).toHaveBeenCalled();

    // Run B's own client drives the status from here…
    const connB = connections[1]!;
    expect(connB.runId).toBe('run_b');
    act(() => connB.onStatusChange!('open'));
    expect(committed[committed.length - 1]).toBe('open');

    // …and a late transition from run A's stale client is discarded.
    act(() => connA.onStatusChange!('closed'));
    expect(committed[committed.length - 1]).toBe('open');
  });
});
