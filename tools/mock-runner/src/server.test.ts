// Integration tests: drive the mock runner over real HTTP + WebSocket (BIBLE
// §5.6). A full run to completion, a WS-drop + HTTP-replay reconnect with no
// gap/duplicate, a mid-run stop, an approval reject, and the degraded bench.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventSchema, reduceRun, type Event } from '@boardex/contract';
import { createMockRunner, type MockRunner } from './server';

const TERMINAL = new Set(['completed', 'failed', 'stopped']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let runner: MockRunner;
let base: string;
let wsBase: string;

beforeAll(async () => {
  // Ephemeral port; speed 200 keeps a full run to well under a couple of seconds.
  runner = await createMockRunner({ port: 0, speed: 200 });
  base = runner.url;
  wsBase = runner.url.replace('http://', 'ws://');
});

afterAll(async () => {
  await runner.close();
});

// --- HTTP helpers -----------------------------------------------------------

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(base + path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function getEvents(runId: string, afterSeq: number): Promise<Event[]> {
  const raw = await getJson<unknown[]>(`/runs/${runId}/events?afterSeq=${afterSeq}`);
  return raw.map((e) => EventSchema.parse(e));
}

async function createRun(): Promise<string> {
  const res = await post('/runs', { taskPrompt: 'bring up BME280', boardProfileId: 'bp_nucleo_f303re' });
  expect(res.status).toBe(200);
  const { runId } = (await res.json()) as { runId: string };
  return runId;
}

// Drive a run to a terminal state over HTTP only: approve the plan when it is
// ready and approve every pending approval as it appears.
async function driveToCompletion(runId: string): Promise<Event[]> {
  const resolved = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const events = await getEvents(runId, 0);
    if (events.length === 0) {
      await sleep(15);
      continue;
    }
    const view = reduceRun(events);
    if (TERMINAL.has(view.run.status)) return events;

    if (view.run.status === 'plan_ready' && !resolved.has('__plan__')) {
      if ((await post(`/runs/${runId}/plan/approve`)).status === 204) resolved.add('__plan__');
    }
    const pending = view.approvals.find((a) => a.status === 'pending');
    if (pending && !resolved.has(pending.id)) {
      const r = await post(`/runs/${runId}/approvals/${pending.id}`, { status: 'approved' });
      if (r.status === 204) resolved.add(pending.id);
    }
    await sleep(15);
  }
  throw new Error('run did not reach a terminal state in time');
}

// Poll the HTTP event log until the reduced view satisfies `pred`, guarding the
// brief window after createRun where the log is still empty.
async function waitForView(
  runId: string,
  pred: (view: ReturnType<typeof reduceRun>) => boolean,
  label: string,
): Promise<{ events: Event[]; view: ReturnType<typeof reduceRun> }> {
  for (let i = 0; i < 600; i++) {
    const events = await getEvents(runId, 0);
    if (events.length > 0) {
      const view = reduceRun(events);
      if (pred(view)) return { events, view };
    }
    await sleep(15);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// --- WebSocket collector ----------------------------------------------------

interface Collector {
  events: Event[];
  waitFor: (pred: (e: Event) => boolean) => Promise<Event>;
  close: () => void;
}

async function connect(query: string): Promise<Collector> {
  const ws = new WebSocket(`${wsBase}/ws?${query}`);
  const events: Event[] = [];
  const waiters: { pred: (e: Event) => boolean; resolve: (e: Event) => void }[] = [];
  ws.on('message', (data: Buffer) => {
    const event = EventSchema.parse(JSON.parse(data.toString()));
    events.push(event);
    for (const w of [...waiters]) {
      if (w.pred(event)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(event);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  return {
    events,
    waitFor: (pred) =>
      new Promise<Event>((resolve) => {
        const hit = events.find(pred);
        if (hit) resolve(hit);
        else waiters.push({ pred, resolve });
      }),
    close: () => ws.close(),
  };
}

// Assert a list of events is gapless and starts exactly where expected.
function assertContiguous(events: Event[], firstSeq: number, lastSeq: number): void {
  expect(events[0]?.seq).toBe(firstSeq);
  expect(events[events.length - 1]?.seq).toBe(lastSeq);
  for (let i = 0; i < events.length; i++) {
    expect(events[i]?.seq).toBe(firstSeq + i);
  }
}

// --- tests ------------------------------------------------------------------

describe('mock runner', () => {
  it('reports runnerKind "mock" and the contract version', async () => {
    const health = await getJson<{ ok: boolean; contractVersion: string; runnerKind: string }>('/health');
    expect(health).toEqual({ ok: true, contractVersion: 'boardex-contract/0.1', runnerKind: 'mock' });
  });

  it('drives a full run to completion over HTTP + WS with the fixture event count', async () => {
    const runId = await createRun();
    const wsCollector = await connect(`runId=${runId}`);

    const events = await driveToCompletion(runId);

    // The happy path emits exactly the fixture's 90 events (no synthetic endings).
    expect(events).toHaveLength(90);
    assertContiguous(events, 1, 90);

    const view = reduceRun(events);
    expect(view.run.status).toBe('completed');
    expect(view.run.iteration).toBe(2); // one fix loop
    expect(view.warnings).toEqual([]); // evidence-linking law satisfied
    expect(view.checks).toHaveLength(3);
    expect(view.checks.every((c) => c.verdict === 'pass')).toBe(true);
    // Both approvals were resolved (plan gate + two approval gates).
    expect(view.approvals).toHaveLength(2);
    expect(view.approvals.every((a) => a.status === 'approved')).toBe(true);

    // The WS stream delivered the terminal event live over the socket.
    await wsCollector.waitFor((e) => e.type === 'run.completed');
    wsCollector.close();
  });

  it('reconnects after a WS drop via HTTP replay with no gap or duplicate', async () => {
    const runId = await createRun();

    // Initial connect mirrors the UI: WS live tail + an afterSeq=0 replay seed.
    const wsA = await connect(`runId=${runId}`);
    const seed = await getEvents(runId, 0);
    const seen = new Map<number, Event>();
    for (const e of seed) seen.set(e.seq, e);
    wsA.events.forEach((e) => seen.set(e.seq, e));

    // Drive the run forward (background), then simulate a mid-run drop once well
    // underway — before the second approval, so live events still lie ahead.
    const driving = driveToCompletion(runId);
    await wsA.waitFor((e) => e.seq >= 40);
    wsA.events.forEach((e) => seen.set(e.seq, e));
    wsA.close();
    const lastSeq = Math.max(...seen.keys());

    // Reconnect a live WS-B and let the run finish; WS-B must receive the tail.
    const wsB = await connect(`runId=${runId}`);
    await wsB.waitFor((e) => e.type === 'run.completed');
    await driving;
    wsB.close();
    // WS-B's live tail is itself gapless and strictly newer than the drop point.
    expect(wsB.events.every((e) => e.seq > lastSeq)).toBe(true);

    // HTTP replay from lastSeq fills the gap: no duplicate, no gap, ends at 90.
    const replay = await getEvents(runId, lastSeq);
    expect(replay.every((e) => e.seq > lastSeq)).toBe(true); // no duplicate
    assertContiguous(replay, lastSeq + 1, 90); // resumes at lastSeq+1, gapless

    // The reconstructed stream (pre-drop + replay) is a gapless 1..90.
    for (const e of replay) seen.set(e.seq, e);
    const merged = [...seen.values()].sort((a, b) => a.seq - b.seq);
    assertContiguous(merged, 1, 90);
    expect(reduceRun(merged).run.status).toBe('completed');
  });

  it('honors stop at any time and refuses a second stop', async () => {
    const runId = await createRun();

    // Get past the plan gate into the running steps.
    await waitForView(runId, (v) => v.run.status === 'plan_ready', 'plan_ready');
    expect((await post(`/runs/${runId}/plan/approve`)).status).toBe(204);
    await waitForView(runId, (v) => v.run.status === 'running', 'running');

    expect((await post(`/runs/${runId}/stop`)).status).toBe(204);

    // Replay settles on run.stopped and stops advancing.
    await sleep(60);
    const afterStop = await getEvents(runId, 0);
    const last = afterStop[afterStop.length - 1];
    expect(last?.type).toBe('run.stopped');
    if (last?.type === 'run.stopped') expect(last.payload.byUser).toBe(true);
    const view = reduceRun(afterStop);
    expect(view.run.status).toBe('stopped');

    // No further events arrive after the terminal stop.
    await sleep(120);
    expect(await getEvents(runId, 0)).toHaveLength(afterStop.length);

    // A second stop is invalid for a terminal run -> 409 with currentStatus.
    const second = await post(`/runs/${runId}/stop`);
    expect(second.status).toBe(409);
    expect((await second.json()) as { currentStatus: string }).toMatchObject({ currentStatus: 'stopped' });
  });

  it('routes an approval reject to a run.stopped alternate ending', async () => {
    const runId = await createRun();

    // Approve the plan, then wait for the first (flash) approval to be pending.
    await waitForView(runId, (v) => v.run.status === 'plan_ready', 'plan_ready');
    expect((await post(`/runs/${runId}/plan/approve`)).status).toBe(204);

    const { view: pendingView } = await waitForView(
      runId,
      (v) => v.approvals.some((a) => a.status === 'pending'),
      'pending approval',
    );
    const pendingId = pendingView.approvals.find((a) => a.status === 'pending')?.id;
    expect(pendingId).toBeTruthy();

    expect((await post(`/runs/${runId}/approvals/${pendingId}`, { status: 'rejected' })).status).toBe(204);

    await waitForView(runId, (v) => v.run.status === 'stopped', 'stopped');
    const events = await getEvents(runId, 0);
    assertContiguous(events, 1, events[events.length - 1]!.seq); // still gapless
    const view = reduceRun(events);
    expect(view.run.status).toBe('stopped');
    const rejected = view.approvals.find((a) => a.id === pendingId);
    expect(rejected?.status).toBe('rejected');
    expect(events[events.length - 1]?.type).toBe('run.stopped');
  });

  it('marks the logic analyzer offline under --degraded', async () => {
    const degraded = await createMockRunner({ port: 0, speed: 200, degraded: true });
    try {
      const res = await fetch(`${degraded.url}/bench`);
      const bench = (await res.json()) as { devices: { kind: string; state: string }[] };
      const la = bench.devices.find((d) => d.kind === 'logic_analyzer');
      expect(la?.state).toBe('offline');
      // Other devices remain online.
      expect(bench.devices.filter((d) => d.kind !== 'logic_analyzer').every((d) => d.state === 'online')).toBe(true);
    } finally {
      await degraded.close();
    }
  });

  it('serves fixture artifacts with the declared MIME type', async () => {
    const res = await fetch(`${base}/artifacts/art_report`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown');
    expect(await res.text()).toContain('#'); // Markdown report body

    const decode = await fetch(`${base}/artifacts/art_i2c_decode_iter1`);
    expect(decode.headers.get('content-type')).toBe('application/json');

    const missing = await fetch(`${base}/artifacts/does_not_exist`);
    expect(missing.status).toBe(404);
  });
});
