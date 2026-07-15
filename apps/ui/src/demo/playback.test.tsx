// Demo playback fidelity (T6.5). The events driven through the demo store must reduce
// to EXACTLY the same RunView as reducing them directly — that identity is the whole
// premise (D5: replay is just reduction). Also covers the paced advance and the
// approve-fast-forwards-to-the-recording's-own-resolution path.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { reduceRun } from '@boardex/contract';
import { DEMO_ENTRIES } from './data/demoRun';
import { rebaseEntries } from './rebase';
import { useDemoPlayback } from './useDemoPlayback';

const events = DEMO_ENTRIES.map((entry) => entry.event);
// The hook rebases to Date.now() at init (§5.6); under a fixed fake clock that is
// deterministic, so the expected view reduces the same rebased stream.
const NOW = Date.parse('2026-07-14T16:00:00.000Z');
const rebasedEvents = () => rebaseEntries(DEMO_ENTRIES, NOW).map((entry) => entry.event);

afterEach(() => {
  vi.useRealTimers();
});

describe('useDemoPlayback', () => {
  it('skipToEnd yields a view identical to reducing the events directly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { result } = renderHook(() => useDemoPlayback());

    act(() => {
      result.current.skipToEnd();
    });

    expect(result.current.status).toBe('ended');
    expect(result.current.cursor).toBe(events.length);
    expect(result.current.view).toEqual(reduceRun(rebasedEvents()));
  });

  it('advances through the recording as time passes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { result } = renderHook(() => useDemoPlayback());
    expect(result.current.cursor).toBe(0);

    // Each event schedules the next only after its state update commits, so walk the
    // clock forward one capped gap at a time, flushing effects between (act) — every
    // recorded gap is ≤ the cap, so a handful of extra ticks drains the whole run.
    for (let i = 0; i < events.length + 4 && result.current.status !== 'ended'; i++) {
      act(() => {
        vi.advanceTimersByTime(2_600);
      });
    }

    expect(result.current.status).toBe('ended');
    expect(result.current.view).toEqual(reduceRun(rebasedEvents()));
  });

  it('approving fast-forwards to the recording’s own resolution of that approval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { result } = renderHook(() => useDemoPlayback());

    act(() => {
      result.current.advanceToApprovalResolution('apr_flash_iter1');
    });

    const resolved = result.current.view?.approvals.find((a) => a.id === 'apr_flash_iter1');
    expect(resolved?.status).toBe('approved');
    // It stops right after the resolution, not at the end of the run.
    expect(result.current.cursor).toBeLessThan(events.length);
  });
});
