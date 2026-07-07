// Shared sample entities for the contract test suites. Test-only; not exported
// from the package index.
import type {
  Approval,
  Artifact,
  BenchStatus,
  BoardProfile,
  Diagnosis,
  MeasurementCheck,
  PlanStep,
  Run,
  RunStep,
} from './entities';
import type { Event } from './events';

export const TS = '2026-07-07T14:03:22.114Z';
export const RUN_ID = 'run_01';

export const sampleRun: Run = {
  id: RUN_ID,
  title: 'BME280 bring-up',
  taskPrompt: 'Bring up BME280 over I2C on the Nucleo-F303RE.',
  boardProfileId: 'bp_01',
  status: 'planning',
  createdAt: TS,
  updatedAt: TS,
  iteration: 1,
};

export const samplePlanStep: PlanStep = {
  index: 0,
  title: 'Build & flash',
  detail: 'Compile the firmware and flash it via pyOCD.',
  riskLevel: 'medium',
  hardwareAction: true,
};

export const sampleRunStep: RunStep = {
  id: 'step_01',
  runId: RUN_ID,
  planIndex: 0,
  kind: 'build',
  status: 'active',
  title: 'Build firmware',
  startedAt: TS,
  artifactIds: [],
};

export const sampleArtifact: Artifact = {
  id: 'art_01',
  runId: RUN_ID,
  stepId: 'step_01',
  kind: 'build_log',
  label: 'Build log',
  mimeType: 'text/plain',
  sizeBytes: 2048,
};

export const sampleCheck: MeasurementCheck = {
  id: 'chk_01',
  runId: RUN_ID,
  requirementId: 'i2c_clock',
  description: 'I2C clock must be 100 kHz ±10%',
  measurement: 'logic_analyzer.i2c.scl_frequency',
  expected: { min: 90000, max: 110000 },
  actual: { value: 99600, unit: 'Hz' },
  verdict: 'pass',
  artifactId: 'art_01',
  sourceRef: 'BME280 datasheet §6.2',
};

export const sampleApproval: Approval = {
  id: 'apr_01',
  runId: RUN_ID,
  proposal: {
    title: 'Flash firmware',
    reason: 'New build must be programmed to the target.',
    riskLevel: 'medium',
    filesChanged: [],
    hardwareActions: ['flash via pyOCD'],
  },
  status: 'pending',
};

export const sampleDiagnosis: Diagnosis = {
  id: 'diag_01',
  runId: RUN_ID,
  failedCheckIds: ['chk_02'],
  hypotheses: [
    {
      cause: 'Wrong 7-bit vs 8-bit I2C address shift',
      evidence: 'NACK at 0x76 in the protocol decode',
      confidence: 'high',
    },
  ],
  proposedFix: {
    summary: 'Correct the address handling',
    riskLevel: 'medium',
    filesChanged: ['src/i2c.c'],
  },
};

export const sampleBoardProfile: BoardProfile = {
  id: 'bp_01',
  name: 'Nucleo-F303RE',
  mcu: 'STM32F303RE',
  repoPath: '/bench/firmware',
  buildCommand: 'make',
  flashCommand: 'pyocd flash build/firmware.elf',
  resetCommand: 'pyocd reset',
  serial: { port: '/dev/ttyACM0', baud: 115200 },
  instruments: {
    debugProbe: 'ST-Link (on-board, via pyOCD)',
    logicAnalyzer: 'Kingst LA2016 (sigrok)',
  },
  safety: {
    maxIterations: 3,
    flashRequiresApproval: true,
    powerNote: 'Powered over USB; unplug before rewiring.',
  },
  connectionChecklist: [{ label: 'SDA', detail: 'PB9 to BME280 SDI' }],
  knownQuirks: ['On-board LD2 shares PA5 with SPI1 SCK'],
};

export const sampleBench: BenchStatus = {
  runnerOnline: true,
  contractVersion: 'boardex-contract/0.1',
  devices: [
    { kind: 'debug_probe', name: 'ST-Link', state: 'online' },
    { kind: 'serial', name: '/dev/ttyACM0', state: 'online' },
    { kind: 'logic_analyzer', name: 'Kingst LA2016', state: 'offline', detail: 'not detected' },
  ],
};

export function envelope<T extends Event['type']>(
  seq: number,
  type: T,
  payload: Extract<Event, { type: T }>['payload'],
  runId: string = RUN_ID,
): Extract<Event, { type: T }> {
  return { seq, runId, ts: TS, type, payload } as Extract<Event, { type: T }>;
}
