// Integration tests: drive the mock runner over real HTTP + WebSocket (BIBLE
// §5.6). A full run to completion, a WS-drop + HTTP-replay reconnect with no
// gap/duplicate, a mid-run stop, an approval reject, and the degraded bench.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  EventSchema,
  GetDocumentMetaResponseSchema,
  HealthResponseSchema,
  ListRunsResponseSchema,
  reduceRun,
  type Event,
  type RunView,
} from '@boardex/contract';
import { loadFixture } from './fixture';
import { createMockRunner, type MockRunner } from './server';

const TERMINAL = new Set(['completed', 'failed', 'stopped']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// BIBLE §10.4 item 2: RUNNER_BASE_URL points this suite at an external (real)
// runner instead of an in-process mock. Cases that depend on mock-only knobs
// (fixture-exact event counts, fail-variant/degraded/slow runners) are skipped
// in external mode; everything else is the shared conformance surface.
const EXTERNAL_BASE = process.env.RUNNER_BASE_URL;
const itMockOnly = EXTERNAL_BASE ? it.skip : it;

let runner: MockRunner | undefined;
let base: string;
let wsBase: string;

beforeAll(async () => {
  if (EXTERNAL_BASE) {
    base = EXTERNAL_BASE.replace(/\/$/, '');
    wsBase = base.replace(/^http/, 'ws');
    return;
  }
  // Ephemeral port; speed 200 keeps a full run to well under a couple of seconds.
  runner = await createMockRunner({ port: 0, speed: 200 });
  base = runner.url;
  wsBase = runner.url.replace('http://', 'ws://');
});

afterAll(async () => {
  await runner?.close();
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
    const view = events.length === 0 ? null : reduceRun(events);
    if (view === null) {
      await sleep(15);
      continue;
    }
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

// "plan_ready" is NOT the same instant as "parked at the plan gate". The fixture emits
// run.status_changed(plan_ready) one event BEFORE run.plan_generated, and the session
// arms the plan gate only after emitting the latter (§5.6) — so between the two there
// is a real window, ~1ms at SPEED=200, in which POST /plan/approve is legitimately 409.
// A loaded CI runner lands a poll inside it (node 20, 2026-07-28).
//
// Waiting on the PLAN closes the window deterministically: the gate is armed in the
// same synchronous stretch that appends run.plan_generated to the log — no await
// between them — and the HTTP handler cannot interleave with it. So any GET that can
// SEE the plan is a GET taken after the gate was armed. Loops that retry an approve
// until it answers 204 are unaffected and keep using the status alone.
const atPlanGate = (view: RunView): boolean =>
  view.run.status === 'plan_ready' && view.run.plan !== undefined;

// Poll the HTTP event log until the reduced view satisfies `pred`, guarding the
// brief window after createRun where the log is still empty.
async function waitForView(
  runId: string,
  pred: (view: RunView) => boolean,
  label: string,
): Promise<{ events: Event[]; view: RunView }> {
  for (let i = 0; i < 600; i++) {
    const events = await getEvents(runId, 0);
    if (events.length > 0) {
      const view = reduceRun(events);
      if (view && pred(view)) return { events, view };
    }
    await sleep(15);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// --- WebSocket collector ----------------------------------------------------

interface Collector {
  events: Event[];
  /** Frames exactly as they arrived on the socket, before any parse (leak greps). */
  raw: string[];
  waitFor: (pred: (e: Event) => boolean) => Promise<Event>;
  close: () => void;
}

async function connect(query: string): Promise<Collector> {
  const ws = new WebSocket(`${wsBase}/ws?${query}`);
  const events: Event[] = [];
  const raw: string[] = [];
  const waiters: { pred: (e: Event) => boolean; resolve: (e: Event) => void }[] = [];
  ws.on('message', (data: Buffer) => {
    raw.push(data.toString());
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
    raw,
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
  it('reports its runnerKind, the contract version, and v2.1 capabilities', async () => {
    const health = await getJson<{
      ok: boolean;
      contractVersion: string;
      runnerKind: string;
      capabilities?: { models?: string[] };
    }>('/health');
    expect(health).toMatchObject({
      ok: true,
      contractVersion: 'boardex-contract/0.1',
      runnerKind: EXTERNAL_BASE ? 'real' : 'mock',
    });
    // T6.3 (riding along for T6.6): the mock advertises exactly one model. An
    // external runner's capabilities are its own; schema-valid is the bar there.
    // `credentials` rides along mock-prototyped (§10.5 proposal): the advertised
    // provider is UNCONFIGURED at boot with no hint, since no MOCK_PROVIDER_KEY was set.
    if (!EXTERNAL_BASE) {
      expect(health).toEqual({
        ok: true,
        contractVersion: 'boardex-contract/0.1',
        runnerKind: 'mock',
        capabilities: { models: ['mock-model'] },
        credentials: [{ provider: 'openrouter', configured: false }],
      });
    }
    // Validates against the contract schema (capabilities is optional there). The
    // parse STRIPS `credentials` — proof it is a mock-prototyped extension and not a
    // contract field: a v2.0 consumer sees a plain HealthResponse.
    const parsed = HealthResponseSchema.parse(health);
    expect(parsed).not.toHaveProperty('credentials');
    expect(parsed).toEqual({ ...health, credentials: undefined });
  });

  it('drives a full run to completion over HTTP + WS with the fixture event count', async () => {
    const runId = await createRun();
    const wsCollector = await connect(`runId=${runId}`);

    const events = await driveToCompletion(runId);

    // The happy path emits exactly the fixture's 90 events (no synthetic endings).
    // An external runner tells its own story; the seq law still holds.
    if (!EXTERNAL_BASE) expect(events).toHaveLength(90);
    assertContiguous(events, 1, events.length);

    const view = reduceRun(events)!;
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
    const finalEvents = await driving;
    const totalSeq = finalEvents[finalEvents.length - 1]!.seq;
    wsB.close();
    // WS-B's live tail is itself gapless and strictly newer than the drop point.
    expect(wsB.events.every((e) => e.seq > lastSeq)).toBe(true);

    // HTTP replay from lastSeq fills the gap: no duplicate, no gap, ends at the
    // stream's terminal seq (exactly 90 for the fixture story).
    if (!EXTERNAL_BASE) expect(totalSeq).toBe(90);
    const replay = await getEvents(runId, lastSeq);
    expect(replay.every((e) => e.seq > lastSeq)).toBe(true); // no duplicate
    assertContiguous(replay, lastSeq + 1, totalSeq); // resumes at lastSeq+1, gapless

    // The reconstructed stream (pre-drop + replay) is gapless from 1.
    for (const e of replay) seen.set(e.seq, e);
    const merged = [...seen.values()].sort((a, b) => a.seq - b.seq);
    assertContiguous(merged, 1, totalSeq);
    expect(reduceRun(merged)!.run.status).toBe('completed');
  });

  it('honors stop at any time and refuses a second stop', async () => {
    const runId = await createRun();

    // Get past the plan gate into the running steps.
    await waitForView(runId, atPlanGate, 'the plan gate');
    expect((await post(`/runs/${runId}/plan/approve`)).status).toBe(204);
    await waitForView(runId, (v) => v.run.status === 'running', 'running');

    expect((await post(`/runs/${runId}/stop`)).status).toBe(204);

    // Replay settles on run.stopped and stops advancing.
    await sleep(60);
    const afterStop = await getEvents(runId, 0);
    const last = afterStop[afterStop.length - 1];
    expect(last?.type).toBe('run.stopped');
    if (last?.type === 'run.stopped') expect(last.payload.byUser).toBe(true);
    const view = reduceRun(afterStop)!;
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
    await waitForView(runId, atPlanGate, 'the plan gate');
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
    const view = reduceRun(events)!;
    expect(view.run.status).toBe('stopped');
    const rejected = view.approvals.find((a) => a.id === pendingId);
    expect(rejected?.status).toBe('rejected');
    expect(events[events.length - 1]?.type).toBe('run.stopped');
  });

  it('sends the dedicated terminal events on the global stream (§5.3 v2.0)', async () => {
    const global = await connect('global=1');
    // The snapshot arrives first (runner.status on connect).
    await global.waitFor((e) => e.type === 'runner.status');

    // Completed terminal: drive a run to its natural end.
    const completedRunId = await createRun();
    void driveToCompletion(completedRunId);
    const completed = await global.waitFor(
      (e) => e.type === 'run.completed' && e.runId === completedRunId,
    );
    expect(completed.type).toBe('run.completed');

    // Stopped terminal: stop a second run mid-flight; the dashboard hears it.
    const stoppedRunId = await createRun();
    await waitForView(stoppedRunId, (v) => v.run.status === 'plan_ready', 'plan_ready');
    expect((await post(`/runs/${stoppedRunId}/stop`)).status).toBe(204);
    await global.waitFor((e) => e.type === 'run.stopped' && e.runId === stoppedRunId);

    global.close();
  });

  itMockOnly('serves a schema-valid RunSummary in the window before run.created replays (T5.0/F7)', async () => {
    // SPEED=1 keeps the fixture's 600 ms pre-run.created delay real, so the GET
    // lands inside the window the audit caught.
    const slow = await createMockRunner({ port: 0, speed: 1 });
    try {
      const res = await fetch(`${slow.url}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskPrompt: 'x', boardProfileId: 'bp_nucleo_f303re' }),
      });
      const { runId } = (await res.json()) as { runId: string };

      const list = (await (await fetch(`${slow.url}/runs`)).json()) as unknown[];
      const summaries = ListRunsResponseSchema.parse(list);
      const summary = summaries.find((s) => s.id === runId);
      expect(summary).toBeDefined();
      expect(summary?.status).toBe('draft');
      expect(summary?.title.length).toBeGreaterThan(0);
      expect(summary?.boardProfileId).toBe('bp_nucleo_f303re');
      expect(Number.isNaN(Date.parse(summary?.updatedAt ?? ''))).toBe(false);
    } finally {
      await slow.close();
    }
  });

  itMockOnly('replays the fail variant to run.failed with no further fix approval (T5.0/F9)', async () => {
    const failing = await createMockRunner({ port: 0, speed: 200, failVariant: true });
    try {
      const res = await fetch(`${failing.url}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskPrompt: 'bring up BME280', boardProfileId: 'bp_nucleo_f303re' }),
      });
      const { runId } = (await res.json()) as { runId: string };

      // Drive the same three gates as the happy path; the ending differs.
      const resolved = new Set<string>();
      let events: Event[] = [];
      for (let i = 0; i < 1000; i++) {
        const raw = await (await fetch(`${failing.url}/runs/${runId}/events?afterSeq=0`)).json();
        events = (raw as unknown[]).map((e) => EventSchema.parse(e));
        if (events.length > 0) {
          const view = reduceRun(events)!;
          if (TERMINAL.has(view.run.status)) break;
          if (view.run.status === 'plan_ready' && !resolved.has('__plan__')) {
            const r = await fetch(`${failing.url}/runs/${runId}/plan/approve`, { method: 'POST' });
            if (r.status === 204) resolved.add('__plan__');
          }
          const pending = view.approvals.find((a) => a.status === 'pending');
          if (pending && !resolved.has(pending.id)) {
            const r = await fetch(`${failing.url}/runs/${runId}/approvals/${pending.id}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'approved' }),
            });
            if (r.status === 204) resolved.add(pending.id);
          }
        }
        await sleep(15);
      }

      expect(events).toHaveLength(85);
      assertContiguous(events, 1, 85);
      expect(events[events.length - 1]?.type).toBe('run.failed');

      const view = reduceRun(events)!;
      expect(view.run.status).toBe('failed');
      expect(view.run.iteration).toBe(2);
      expect(view.warnings).toEqual([]);
      // Both approvals were the base story's; nothing new was requested after the
      // iteration-2 checks failed.
      expect(view.approvals).toHaveLength(2);
      expect(view.approvals.every((a) => a.status === 'approved')).toBe(true);
      const verdicts = new Map(view.checks.map((c) => [c.requirementId, c.verdict]));
      expect(verdicts.get('i2c_clock')).toBe('pass');
      expect(verdicts.get('device_ack')).toBe('fail');
      expect(verdicts.get('serial_output')).toBe('fail');
      // The variant's evidence is fetchable like any other artifact.
      const decode = await fetch(`${failing.url}/artifacts/art_i2c_decode_iter2f`);
      expect(decode.status).toBe(200);
      expect(decode.headers.get('content-type')).toBe('application/json');
    } finally {
      await failing.close();
    }
  });

  itMockOnly('a stop that beats run.created still yields a reducible stream (T5.0 FIX_FIRST F1)', async () => {
    // SPEED=1 keeps the fixture's 600 ms pre-run.created delay real, so the stop
    // lands in the window curl can hit: POST /runs then POST /stop immediately.
    const slow = await createMockRunner({ port: 0, speed: 1 });
    try {
      const res = await fetch(`${slow.url}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskPrompt: 'x', boardProfileId: 'bp_nucleo_f303re' }),
      });
      const { runId } = (await res.json()) as { runId: string };

      const stop = await fetch(`${slow.url}/runs/${runId}/stop`, { method: 'POST' });
      expect(stop.status).toBe(204);

      // The log used to open with run.status_changed — unreducible by contract.
      // Now it opens with the fixture's run.created and ends in run.stopped.
      const raw = (await (await fetch(`${slow.url}/runs/${runId}/events?afterSeq=0`)).json()) as unknown[];
      const events = raw.map((e) => EventSchema.parse(e));
      expect(events[0]?.type).toBe('run.created');
      expect(events[events.length - 1]?.type).toBe('run.stopped');
      assertContiguous(events, 1, events.length);

      const view = reduceRun(events);
      expect(view).not.toBeNull();
      expect(view?.run.status).toBe('stopped');
    } finally {
      await slow.close();
    }
  });

  itMockOnly('marks the logic analyzer offline under --degraded', async () => {
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

  // §5.6 (T6.1b): replayed timestamps rebase to replay start — run.created ≈ the
  // POST /runs moment, authored inter-event deltas preserved — so elapsed reads
  // true during demos. The fixture file itself stays authored-time.
  it('rebases replayed timestamps to replay start, preserving deltas', async () => {
    const before = Date.now();
    const runId = await createRun();
    const { events } = await waitForView(
      runId,
      (v) => v.run.status === 'plan_ready',
      'plan_ready',
    );

    const created = events.find((e) => e.type === 'run.created');
    expect(created).toBeDefined();
    // ≈ now: within the window between POST and this assertion, plus slack for
    // the first entry's (speed-scaled) delay.
    expect(Date.parse(created!.ts)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(created!.ts)).toBeLessThanOrEqual(Date.now() + 1000);
    // Payload timestamps shift with the envelope — elapsed reads run.createdAt.
    const createdAt = created!.type === 'run.created' ? created!.payload.run.createdAt : '';
    expect(Date.parse(createdAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(createdAt)).toBeLessThanOrEqual(Date.now() + 1000);

    // Deltas between replayed fixture events match the authored fixture exactly.
    const authored = loadFixture();
    const authoredDelta =
      Date.parse(authored[1]!.event.ts) - Date.parse(authored[0]!.event.ts);
    const replayedDelta = Date.parse(events[1]!.ts) - Date.parse(events[0]!.ts);
    expect(replayedDelta).toBe(authoredDelta);
  });

  it('serves artifacts by reference with the declared MIME type', async () => {
    // Derive artifact ids from a completed run's own stream, so the same
    // assertions hold for the fixture story and for an external runner's.
    const runId = await createRun();
    const events = await driveToCompletion(runId);
    const view = reduceRun(events)!;
    expect(view.artifacts.length).toBeGreaterThan(0);

    const report = view.artifacts.find((a) => a.kind === 'report_md');
    expect(report).toBeDefined();
    expect(report?.mimeType).toBe('text/markdown');
    const res = await fetch(`${base}/artifacts/${report!.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown');
    expect(await res.text()).toContain('#'); // Markdown report body

    const decodeMeta = view.artifacts.find((a) => a.kind === 'protocol_decode');
    expect(decodeMeta).toBeDefined();
    const decode = await fetch(`${base}/artifacts/${decodeMeta!.id}`);
    expect(decode.headers.get('content-type')).toBe('application/json');

    const missing = await fetch(`${base}/artifacts/does_not_exist`);
    expect(missing.status).toBe(404);
  });

  // v2.1 (T6.3): the canned profile carries two authored documents and the runner
  // serves them by reference with the declared MIME type. Mock-only: the document
  // ids and their content are authored fixture facts, and /documents is a v2.1
  // route an external runner may not serve yet.
  itMockOnly('lists the profile documents and serves them by reference (T6.3)', async () => {
    const profiles = await getJson<
      { id: string; documents?: { id: string; kind: string; mimeType: string }[] }[]
    >('/board-profiles');
    const nucleo = profiles.find((p) => p.id === 'bp_nucleo_f303re');
    expect(nucleo?.documents?.map((d) => d.id).sort()).toEqual([
      'doc_bme280_datasheet',
      'doc_schematic_notes',
    ]);

    // Content by reference, MIME honored.
    const datasheet = await fetch(`${base}/documents/doc_bme280_datasheet`);
    expect(datasheet.status).toBe(200);
    expect(datasheet.headers.get('content-type')).toBe('text/markdown');
    const md = await datasheet.text();
    // The headings the fixture's sourceDoc locators point at are present, and the
    // technical facts are consistent with the fixture story.
    expect(md).toContain('## I2C device addressing');
    expect(md).toContain('## Timing specifications');
    expect(md).toContain('0x76');
    expect(md).toContain('0xEC');

    // Meta returns the BoardDocument descriptor and validates against the contract.
    const meta = await getJson('/documents/doc_bme280_datasheet/meta');
    const doc = GetDocumentMetaResponseSchema.parse(meta);
    expect(doc).toMatchObject({
      id: 'doc_bme280_datasheet',
      kind: 'datasheet',
      mimeType: 'text/markdown',
    });

    // The schematic notes carry the pin mapping.
    const schematic = await (await fetch(`${base}/documents/doc_schematic_notes`)).text();
    expect(schematic).toContain('PB8');
    expect(schematic).toContain('PB9');

    const missing = await fetch(`${base}/documents/does_not_exist`);
    expect(missing.status).toBe(404);
    expect((await fetch(`${base}/documents/does_not_exist/meta`)).status).toBe(404);
  });

  // v2.1 (T6.3): a model chosen at create-run time is echoed onto the run.created
  // Run; omitting it leaves the Run without a model (feature-detected end to end).
  // Mock-only: 'mock-model' is the mock's advertised knob, and CreateRun.model is
  // a v2.1 field an external runner may not echo yet.
  itMockOnly('echoes a chosen model onto run.created, and omits it when unspecified (T6.3)', async () => {
    const withModel = await post('/runs', {
      taskPrompt: 'bring up BME280',
      boardProfileId: 'bp_nucleo_f303re',
      model: 'mock-model',
    });
    const { runId } = (await withModel.json()) as { runId: string };
    const { events } = await waitForView(runId, (v) => v.run.status !== 'draft', 'run.created');
    const created = events.find((e) => e.type === 'run.created');
    expect(created?.type === 'run.created' && created.payload.run.model).toBe('mock-model');

    const plainId = await createRun();
    const { events: plainEvents } = await waitForView(
      plainId,
      (v) => v.run.status !== 'draft',
      'run.created (no model)',
    );
    const plainCreated = plainEvents.find((e) => e.type === 'run.created');
    expect(plainCreated?.type === 'run.created' && plainCreated.payload.run.model).toBeUndefined();
  });

  // Quick Start's path probe (v0). Mock-only: POST /workspace/validate is a §10.5
  // PROPOSAL prototyped here, not a contract route — an external runner answers 404,
  // which is exactly the signal the UI feature-detects on. The resolution rules
  // themselves are covered against a real tree in workspace.test.ts; this pins the
  // HTTP surface: the body shape in, the response shape out, and 400 on a bad body.
  itMockOnly('validates a workspace path over HTTP (mock-prototyped, §10.5 proposal)', async () => {
    const probe = await post('/workspace/validate', { path: process.cwd() });
    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({
      exists: true,
      kind: expect.stringMatching(/^(firmware|directory)$/),
    });

    const missing = await post('/workspace/validate', { path: '/definitely/not/a/real/path' });
    expect(await missing.json()).toEqual({ ok: false, exists: false, kind: 'missing' });

    // A body without a string path is a client error, never a guessed answer — and
    // never a 500 either: a literal null body is a malformed request, not a runner bug.
    expect((await post('/workspace/validate', {})).status).toBe(400);
    expect((await post('/workspace/validate', { path: 42 })).status).toBe(400);
    // Raw fetch, not post(): the helper's `body ?? {}` would turn a null into an
    // object and never exercise the null branch.
    const rawBody = (body: string): Promise<Response> =>
      fetch(`${base}/workspace/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    expect((await rawBody('null')).status).toBe(400);
    expect((await rawBody('"not an object"')).status).toBe(400);
    expect((await rawBody('[]')).status).toBe(400);
    expect((await fetch(`${base}/workspace/validate`)).status).toBe(405);
  });

  // A run is created against the profile the request named — the id the UI resolves
  // the run's safety context (D12 checklist) by. Mock-only: it asserts the mock's
  // substitution onto the canned story, which an external runner has no notion of.
  itMockOnly('creates the run against the requested board profile id', async () => {
    const res = await post('/runs', {
      taskPrompt: 'bring up the BME280',
      boardProfileId: 'bp_quickstart_compiled',
    });
    const { runId } = (await res.json()) as { runId: string };
    const { events } = await waitForView(runId, (v) => v.run.status !== 'draft', 'run.created');
    const created = events.find((e) => e.type === 'run.created');
    expect(created?.type === 'run.created' && created.payload.run.boardProfileId).toBe(
      'bp_quickstart_compiled',
    );
    // The summary GET /runs serves agrees — one identity, not two.
    const summaries = ListRunsResponseSchema.parse(await getJson('/runs'));
    expect(summaries.find((s) => s.id === runId)?.boardProfileId).toBe('bp_quickstart_compiled');
  });

  // Provider credentials (v0). Mock-only: PUT /credentials, DELETE /credentials/{p} and
  // /health's `credentials` advertisement are a §10.5 PROPOSAL prototyped here, not
  // contract routes — an external runner has no notion of them. The store's own rules
  // live in credentials.test.ts; this pins the HTTP surface and the reflection.
  itMockOnly('stores, reflects, and removes a provider key (write-only, hint only)', async () => {
    const key = 'sk-or-v1-http-surface-0000f92a';
    const advertised = async (): Promise<{ provider: string; configured: boolean; hint?: string }> =>
      (await getJson<{ credentials: { provider: string; configured: boolean; hint?: string }[] }>(
        '/health',
      )).credentials[0]!;

    expect(await advertised()).toEqual({ provider: 'openrouter', configured: false });

    const put = (body: unknown): Promise<Response> =>
      fetch(`${base}/credentials`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await put({ provider: 'openrouter', apiKey: key })).status).toBe(204);
    // Reflection: presence plus the masked tail — the key itself is nowhere in it.
    expect(await advertised()).toEqual({ provider: 'openrouter', configured: true, hint: '…f92a' });

    // Validation. An unknown provider is 404 (the route, not the payload); a key that
    // is empty or not a string is 400; a null/non-object body is 400, never a 500.
    expect((await put({ provider: 'anthropic', apiKey: key })).status).toBe(404);
    expect((await put({ provider: 'openrouter', apiKey: '' })).status).toBe(400);
    expect((await put({ provider: 'openrouter', apiKey: 42 })).status).toBe(400);
    expect((await put({ provider: 'openrouter' })).status).toBe(400);
    const rawPut = (body: string): Promise<Response> =>
      fetch(`${base}/credentials`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    expect((await rawPut('null')).status).toBe(400);
    expect((await rawPut('"not an object"')).status).toBe(400);

    // NO read-back route exists, by design: the store is write-only, so a GET is simply
    // not a method this resource has.
    expect((await fetch(`${base}/credentials`)).status).toBe(405);
    expect((await fetch(`${base}/credentials/openrouter`)).status).toBe(405);

    // None of the rejections disturbed the stored key.
    expect(await advertised()).toMatchObject({ configured: true, hint: '…f92a' });

    const del = (provider: string): Promise<Response> =>
      fetch(`${base}/credentials/${provider}`, { method: 'DELETE' });
    expect((await del('anthropic')).status).toBe(404);
    expect((await del('openrouter')).status).toBe(204);
    expect(await advertised()).toEqual({ provider: 'openrouter', configured: false });
    // Removing what is already gone is not an error — Settings' Remove is idempotent.
    expect((await del('openrouter')).status).toBe(204);
  });

  // The invariant the whole feature rests on: a stored key is unreachable from every
  // OTHER surface. Set one, drive a complete run, then grep the run's entire event
  // output, every artifact body it produced, and a batch of error responses for the key.
  itMockOnly('never leaks a stored key into events, artifacts, or error bodies', async () => {
    const key = 'sk-or-v1-leak-canary-abcdef123456';
    expect(
      (
        await fetch(`${base}/credentials`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'openrouter', apiKey: key }),
        })
      ).status,
    ).toBe(204);

    const runId = await createRun();
    // A security grep must read WIRE BYTES: schema parsing STRIPS unknown keys, so a key
    // echoed into a non-contract payload field would be laundered by the parse — passing
    // a grep over the parsed view while still going out on the socket and the replay.
    const wsCollector = await connect(`runId=${runId}`);
    const events = await driveToCompletion(runId);
    expect(events.length).toBeGreaterThan(1);

    // The live socket's frames, exactly as they arrived.
    await wsCollector.waitFor((e) => e.type === 'run.completed');
    expect(wsCollector.raw.length).toBeGreaterThan(0);
    for (const frame of wsCollector.raw) expect(frame).not.toContain(key);
    wsCollector.close();

    // And the HTTP replay body, unparsed.
    const replayBody = await (await fetch(`${base}/runs/${runId}/events?afterSeq=0`)).text();
    expect(replayBody.length).toBeGreaterThan(0);
    expect(replayBody).not.toContain(key);

    // Every artifact the run produced, fetched by reference exactly as the UI does.
    const artifactIds = events.flatMap((e) =>
      e.type === 'artifact.created' ? [e.payload.artifact.id] : [],
    );
    expect(artifactIds.length).toBeGreaterThan(0);
    const bodies = await Promise.all(
      artifactIds.map(async (id) => (await fetch(`${base}/artifacts/${id}`)).text()),
    );
    for (const body of bodies) expect(body).not.toContain(key);

    // Error bodies, including the ones produced by mishandling the credential routes
    // themselves — a rejection must never echo the submitted key back.
    const errorResponses = await Promise.all([
      fetch(`${base}/credentials`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', apiKey: key }),
      }),
      fetch(`${base}/credentials`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openrouter', apiKey: '' }),
      }),
      fetch(`${base}/credentials`),
      fetch(`${base}/runs/run_does_not_exist/events?afterSeq=0`),
      fetch(`${base}/artifacts/art_does_not_exist`),
      fetch(`${base}/health`),
    ]);
    for (const res of errorResponses) expect(await res.text()).not.toContain(key);

    await fetch(`${base}/credentials/openrouter`, { method: 'DELETE' });
  });

  it('returns 404 for an unknown run id on every run route', async () => {
    expect((await fetch(`${base}/runs/run_does_not_exist/events?afterSeq=0`)).status).toBe(404);
    expect((await post('/runs/run_does_not_exist/stop')).status).toBe(404);
    expect((await post('/runs/run_does_not_exist/plan/approve')).status).toBe(404);
    expect(
      (await post('/runs/run_does_not_exist/approvals/apr_x', { status: 'approved' })).status,
    ).toBe(404);
  });
});
