// Event factories for workspace tests: RunViews are always produced by the real
// reduceRun over a synthetic stream (D5 — never hand-assembled views).
import { reduceRun, type Event, type PlanStep, type Run, type RunStep, type RunView } from '@boardex/contract';

export const TS = '2026-07-08T12:00:00.000Z';
export const RUN_ID = 'run_t21';

export const run: Run = {
  id: RUN_ID,
  title: 'Bring up BME280',
  taskPrompt:
    'Bring up the BME280 sensor over I2C on this STM32 board. Verify timing and confirm valid temperature/humidity readings over serial.',
  boardProfileId: 'bp_nucleo_f303re',
  status: 'running',
  createdAt: TS,
  updatedAt: TS,
  iteration: 1,
};

export function planStep(index: number, title: string): PlanStep {
  return { index, title, detail: `Detail for ${title}`, riskLevel: 'low', hardwareAction: false };
}

export function runStep(id: string, planIndex: number, title: string): RunStep {
  return {
    id,
    runId: RUN_ID,
    planIndex,
    kind: 'build',
    status: 'active',
    title,
    startedAt: TS,
    artifactIds: [],
  };
}

type Payload<T extends Event['type']> = Extract<Event, { type: T }>['payload'];

export function envelope<T extends Event['type']>(seq: number, type: T, payload: Payload<T>): Event {
  return { seq, runId: RUN_ID, ts: TS, type, payload } as Event;
}

export const viewFrom = (events: Event[]): RunView => reduceRun(events);
