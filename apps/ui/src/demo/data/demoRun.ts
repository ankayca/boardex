// The bundled demo run (T6.5, BIBLE §7.1 demo mode / §8 T6.5). Generated from the
// authored fixture packages/contract/fixtures/bme280_run_001.jsonl — a complete BME280
// bring-up (plan → 2 approvals → 6 checks → step.failed → diagnosis → iteration 2 →
// completion → report). Ships as a static asset so the demo replays on a fresh install
// with the runner offline (D5: replay is just reduction). Per decisions.md (2026-07-14)
// a genuine AgentBench recording swaps in here later with no code change.
//
// Each entry is { delayMs, event } exactly as the mock's FIXTURE_FILE format (§5.5).
// Every event is validated through the contract parser at load: a bad regeneration
// fails loudly here, never silently mid-demo.
import { parseWireEvent, type WireEvent } from '@boardex/contract';
import rawEntries from './demoRun.json';

export interface DemoEntry {
  /** Recorded wall-clock gap before this event (§5.5); compressed for playback. */
  readonly delayMs: number;
  readonly event: WireEvent;
}

const raw = rawEntries as ReadonlyArray<{ delayMs: number; event: unknown }>;

export const DEMO_ENTRIES: readonly DemoEntry[] = raw.map((entry, index) => {
  const event = parseWireEvent(entry.event);
  if (!event) {
    throw new Error(`demoRun.json entry ${index} is not a valid contract event envelope`);
  }
  return { delayMs: entry.delayMs, event };
});

// The recorded run's id (from its run.created). The demo shell routes and the demo
// store key on it.
export const DEMO_RUN_ID = 'run_bme280_001';
