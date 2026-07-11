import { beforeEach, describe, expect, it } from 'vitest';
import type { Event, Run, RunStep, WireEvent } from '@boardex/contract';
import { createRunStore, type RunStore } from './runStore';

const RUN_ID = 'run_store_test';
const at = (s: number): string => `2026-07-07T14:00:0${s}.000Z`;

const run: Run = {
  id: RUN_ID,
  title: 'BME280 bring-up',
  taskPrompt: 'bring up the sensor',
  boardProfileId: 'bp_nucleo_f303re',
  status: 'running',
  createdAt: at(0),
  updatedAt: at(0),
  iteration: 1,
};

const step: RunStep = {
  id: 'step_1',
  runId: RUN_ID,
  planIndex: 0,
  kind: 'build',
  status: 'active',
  title: 'Build firmware',
  artifactIds: [],
};

// A minimal but complete happy-path stream: created -> running -> one step -> done.
const events: Event[] = [
  { seq: 1, runId: RUN_ID, ts: at(0), type: 'run.created', payload: { run } },
  { seq: 2, runId: RUN_ID, ts: at(1), type: 'run.status_changed', payload: { status: 'running' } },
  { seq: 3, runId: RUN_ID, ts: at(2), type: 'step.started', payload: { step } },
  {
    seq: 4,
    runId: RUN_ID,
    ts: at(3),
    type: 'step.completed',
    payload: { stepId: 'step_1', summary: 'built clean', artifactIds: [] },
  },
  {
    seq: 5,
    runId: RUN_ID,
    ts: at(4),
    type: 'run.completed',
    payload: { summary: 'all checks passed', reportArtifactId: 'art_report' },
  },
];

describe('runStore', () => {
  let store: RunStore;
  beforeEach(() => {
    store = createRunStore();
  });

  it('reduces a contiguous stream to the final view', () => {
    store.getState().ingestMany(RUN_ID, events);
    const view = store.getState().runs[RUN_ID]?.view;
    expect(view?.run.status).toBe('completed');
    expect(view?.steps).toHaveLength(1);
    expect(view?.steps[0]?.status).toBe('succeeded');
    expect(view?.lastSeq).toBe(5);
    expect(view?.warnings).toEqual([]);
    expect(store.getState().lastContiguousSeq(RUN_ID)).toBe(5);
  });

  it('is idempotent: replaying the stream yields a referentially stable view', () => {
    store.getState().ingestMany(RUN_ID, events);
    const first = store.getState().runs[RUN_ID]?.view;
    store.getState().ingestMany(RUN_ID, events); // duplicate every seq
    const second = store.getState().runs[RUN_ID]?.view;
    // No recompute on duplicate seqs — the memoized view keeps its identity.
    expect(second).toBe(first);
  });

  it('is order-independent: shuffled ingestion yields the same final view', () => {
    const shuffled = [events[4], events[1], events[3], events[0], events[2]] as Event[];
    for (const event of shuffled) store.getState().ingest(RUN_ID, event);
    const view = store.getState().runs[RUN_ID]?.view;
    expect(view?.run.status).toBe('completed');
    expect(view?.lastSeq).toBe(5);
  });

  it('parks derivation on a seq gap until the missing event fills it', () => {
    store.getState().ingest(RUN_ID, events[0] as Event); // seq 1
    store.getState().ingest(RUN_ID, events[1] as Event); // seq 2
    store.getState().ingest(RUN_ID, events[3] as Event); // seq 4 (gap at 3)
    store.getState().ingest(RUN_ID, events[4] as Event); // seq 5

    let view = store.getState().runs[RUN_ID]?.view;
    expect(view?.run.status).toBe('running'); // stalled at the contiguous seq-2 prefix
    expect(store.getState().lastContiguousSeq(RUN_ID)).toBe(2);

    store.getState().ingest(RUN_ID, events[2] as Event); // seq 3 fills the gap
    view = store.getState().runs[RUN_ID]?.view;
    expect(view?.run.status).toBe('completed');
    expect(store.getState().lastContiguousSeq(RUN_ID)).toBe(5);
  });

  it('treats a duplicate seq as a no-op that does not mutate state', () => {
    store.getState().ingestMany(RUN_ID, events);
    const before = store.getState().runs;
    // Same seq, different payload timestamp: still ignored (idempotent by seq).
    store.getState().ingest(RUN_ID, { ...(events[2] as Event), ts: at(9) });
    expect(store.getState().runs).toBe(before);
  });

  // §5.2 does not promise run.created is seq 1: an ignored envelope (unknown type,
  // §5.1) can legally precede it (T5.0 FIX_FIRST F1).
  describe('ignored envelopes before run.created (T5.0 FIX_FIRST F1)', () => {
    const ignoredAt = (seq: number): WireEvent => ({
      seq,
      runId: RUN_ID,
      ts: at(seq),
      type: 'run.paused',
      payload: {},
      ignored: true,
    });
    const shift = (by: number): WireEvent[] =>
      events.map((event) => ({ ...event, seq: event.seq + by }) as WireEvent);

    it('live path: ingest of an ignored seq 1, then run.created at seq 2, materializes the view', () => {
      for (const event of [ignoredAt(1), ...shift(1)]) store.getState().ingest(RUN_ID, event);
      const entry = store.getState().runs[RUN_ID];
      expect(entry?.view?.run.status).toBe('completed');
      expect(entry?.view?.lastSeq).toBe(6);
      expect(entry?.reduceError).toBeNull();
    });

    it('replay path: ingestMany over the same stream materializes the same view', () => {
      store.getState().ingestMany(RUN_ID, [ignoredAt(1), ...shift(1)]);
      const entry = store.getState().runs[RUN_ID];
      expect(entry?.view?.run.status).toBe('completed');
      expect(entry?.view?.lastSeq).toBe(6);
      expect(entry?.reduceError).toBeNull();
    });

    it('a stream of only ignored envelopes is a null view, no throw — and no wedge', () => {
      store.getState().ingest(RUN_ID, ignoredAt(1));
      store.getState().ingest(RUN_ID, ignoredAt(2));
      const parked = store.getState().runs[RUN_ID];
      expect(parked?.view).toBeNull();
      expect(parked?.reduceError).toBeNull();
      // The prefix still advanced — the replay cursor is not stuck at 0.
      expect(store.getState().lastContiguousSeq(RUN_ID)).toBe(2);

      // The stream is not wedged: run.created arriving later materializes the view.
      store.getState().ingestMany(RUN_ID, shift(2));
      expect(store.getState().runs[RUN_ID]?.view?.run.status).toBe('completed');
      expect(store.getState().lastContiguousSeq(RUN_ID)).toBe(7);
    });

    it('a KNOWN-typed stream that starts wrong is caught: recorded, view held stable, no throw', () => {
      const wrongStart = { ...(events[1] as Event), seq: 1 }; // run.status_changed at seq 1
      expect(() => store.getState().ingest(RUN_ID, wrongStart)).not.toThrow();
      const entry = store.getState().runs[RUN_ID];
      expect(entry?.view).toBeNull();
      expect(entry?.reduceError).toContain('run.created');

      // Later events keep ingesting without throwing; the view stays stable.
      expect(() =>
        store.getState().ingest(RUN_ID, { ...(events[2] as Event), seq: 2 }),
      ).not.toThrow();
      expect(store.getState().runs[RUN_ID]?.view).toBeNull();
      expect(store.getState().lastContiguousSeq(RUN_ID)).toBe(2);
    });
  });
});
