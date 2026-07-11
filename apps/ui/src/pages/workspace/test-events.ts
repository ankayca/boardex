// Event factories for workspace tests: RunViews are always produced by the real
// reduceRun over a synthetic stream (D5 — never hand-assembled views).
import {
  reduceRun,
  type Approval,
  type Artifact,
  type Diagnosis,
  type Event,
  type MeasurementCheck,
  type PlanStep,
  type Run,
  type RunStep,
  type RunView,
} from '@boardex/contract';

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

export function approval(id: string, proposal?: Partial<Approval['proposal']>): Approval {
  return {
    id,
    runId: RUN_ID,
    proposal: {
      title: 'Flash firmware to the Nucleo-F303RE',
      reason: 'The build must be programmed to the target before I2C capture.',
      riskLevel: 'medium',
      filesChanged: ['main.c'],
      hardwareActions: ['Flash bme280-f303re.elf via pyOCD', 'Reset target after programming'],
      ...proposal,
    },
    status: 'pending',
  };
}

export function artifact(id: string): Artifact {
  return {
    id,
    runId: RUN_ID,
    stepId: 'st_capture',
    kind: 'protocol_decode',
    label: id,
    mimeType: 'application/json',
    sizeBytes: 512,
  };
}

export function artifactOf(id: string, kind: Artifact['kind']): Artifact {
  return {
    id,
    runId: RUN_ID,
    stepId: 'st',
    kind,
    label: id,
    mimeType: 'application/octet-stream',
    sizeBytes: 128,
  };
}

export function checkOf(
  id: string,
  requirementId: string,
  artifactId: string,
  verdict: MeasurementCheck['verdict'],
): MeasurementCheck {
  return {
    id,
    runId: RUN_ID,
    requirementId,
    description: `${requirementId} requirement`,
    measurement: `measurement.${requirementId}`,
    expected: { equals: true },
    actual: { value: verdict === 'pass' },
    verdict,
    artifactId,
  };
}

export function failedCheck(id: string, artifactId: string, description: string): MeasurementCheck {
  return {
    id,
    runId: RUN_ID,
    requirementId: id,
    description,
    measurement: 'logic_analyzer.i2c.ack',
    expected: { equals: true },
    actual: { value: false },
    verdict: 'fail',
    artifactId,
  };
}

export function diagnosis(
  hypotheses: Diagnosis['hypotheses'],
  failedCheckIds: string[] = [],
): Diagnosis {
  return {
    id: 'diag_t22',
    runId: RUN_ID,
    failedCheckIds,
    hypotheses,
    proposedFix: {
      summary: 'Compose CR2 SADD from the shifted address and re-flash.',
      riskLevel: 'medium',
      filesChanged: ['main.c'],
    },
  };
}

type Payload<T extends Event['type']> = Extract<Event, { type: T }>['payload'];

export function envelope<T extends Event['type']>(seq: number, type: T, payload: Payload<T>): Event {
  return { seq, runId: RUN_ID, ts: TS, type, payload } as Event;
}

// reduceRun returns null only while a stream has no known event yet (T5.0
// FIX_FIRST F1); every stream these suites build starts with run.created.
export const viewFrom = (events: Event[]): RunView => {
  const view = reduceRun(events);
  if (view === null) throw new Error('expected reduceRun to materialize a view');
  return view;
};
