// FIXTURE_FILE override (§10.3): the mock replays an arbitrary recorded run —
// here the first real-hardware agent run under records/bmp180-run — instead of
// the authored contract fixtures, serving its artifacts from the recording's own
// sibling artifacts/ directory. This is the seam the demo-asset strategy and the
// records/ replay validation depend on.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventSchema, reduceRun, type Event } from '@boardex/contract';
import { buildArtifactCatalog, loadFixtureFile } from './fixture';
import { createMockRunner, type MockRunner } from './server';

const RECORD = fileURLToPath(
  new URL('../../../records/bmp180-run/recorded_run.jsonl', import.meta.url),
);
const RECORDING_RUN_ID = 'run_fc45bae2d6f8'; // the id baked into the recording
const TERMINAL = new Set(['completed', 'failed', 'stopped']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('FIXTURE_FILE replays an arbitrary recorded run', () => {
  let runner: MockRunner;
  let base: string;

  beforeAll(async () => {
    runner = await createMockRunner({ port: 0, speed: 200, fixtureFile: RECORD });
    base = runner.url;
  });
  afterAll(async () => {
    await runner?.close();
  });

  it('loadFixtureFile parses the recording and resolves its sibling artifacts/', () => {
    const { entries, artifactsDir } = loadFixtureFile(RECORD);
    expect(entries).toHaveLength(186);
    expect(artifactsDir.endsWith('records/bmp180-run/artifacts/')).toBe(true);
    const catalog = buildArtifactCatalog(entries, artifactsDir);
    expect(catalog.size).toBe(15);
    // Every catalogued artifact resolves to real, non-empty bytes on disk.
    for (const { filePath } of catalog.values()) {
      expect(readFileSync(filePath).length).toBeGreaterThan(0);
    }
  });

  it('drives POST /runs to run.failed, rekeyed, with artifacts served by reference', async () => {
    const res = await fetch(base + '/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskPrompt: 'replay', boardProfileId: 'bp_nucleo_f303re' }),
    });
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    // Fresh id, not the recording's own — rekeying is dynamic per recording.
    expect(runId).not.toBe(RECORDING_RUN_ID);

    // Drive the plan gate + every approval to the recording's natural terminal.
    const resolved = new Set<string>();
    let events: Event[] = [];
    for (let i = 0; i < 3000; i++) {
      const raw = (await (
        await fetch(`${base}/runs/${runId}/events?afterSeq=0`)
      ).json()) as unknown[];
      events = raw.map((e) => EventSchema.parse(e));
      const view = events.length ? reduceRun(events) : null;
      if (view && TERMINAL.has(view.run.status)) break;
      if (view?.run.status === 'plan_ready' && !resolved.has('__plan__')) {
        if ((await fetch(`${base}/runs/${runId}/plan/approve`, { method: 'POST' })).status === 204) {
          resolved.add('__plan__');
        }
      }
      const pending = view?.approvals.find((a) => a.status === 'pending');
      if (pending && !resolved.has(pending.id)) {
        const r = await fetch(`${base}/runs/${runId}/approvals/${pending.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'approved' }),
        });
        if (r.status === 204) resolved.add(pending.id);
      }
      await sleep(8);
    }

    const view = reduceRun(events)!;
    expect(view.run.status).toBe('failed');
    expect(view.run.id).toBe(runId);
    expect(view.artifacts).toHaveLength(15);
    // Every emitted event was rekeyed to this session — none carry the source id.
    expect(events.every((e) => e.runId === runId)).toBe(true);

    // Artifact bodies come from records/bmp180-run/artifacts/ by reference.
    const report = view.artifacts.find((a) => a.kind === 'report_md')!;
    const reportBody = await (await fetch(`${base}/artifacts/${report.id}`)).text();
    expect(reportBody).toContain('BMP180');
    const decode = view.artifacts.find((a) => a.kind === 'protocol_decode')!;
    expect((await fetch(`${base}/artifacts/${decode.id}`)).status).toBe(200);
    const serials = view.artifacts.filter((a) => a.kind === 'serial_log');
    const serialBodies = await Promise.all(
      serials.map((a) => fetch(`${base}/artifacts/${a.id}`).then((r) => r.text())),
    );
    // The RTT capture that proves the sensor answered is served by reference.
    expect(serialBodies.some((b) => b.includes('chip_id=0x55'))).toBe(true);
  });
});
