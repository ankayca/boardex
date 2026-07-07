import { describe, expect, it } from 'vitest';
import { EventEnvelopeSchema, EventSchema, type Event } from './events';
import {
  envelope,
  sampleApproval,
  sampleArtifact,
  sampleBench,
  sampleCheck,
  sampleDiagnosis,
  samplePlanStep,
  sampleRun,
  sampleRunStep,
  TS,
} from './test-samples';

// One representative event per catalog entry (§5.2), plus the batched step.log form.
const catalog: Record<string, Event> = {
  'run.created': envelope(1, 'run.created', { run: sampleRun }),
  'run.plan_generated': envelope(2, 'run.plan_generated', {
    plan: [samplePlanStep],
    riskSummary: 'One medium-risk hardware action (flash).',
  }),
  'run.status_changed': envelope(3, 'run.status_changed', {
    status: 'running',
    reason: 'plan approved',
  }),
  'step.started': envelope(4, 'step.started', { step: sampleRunStep }),
  'step.log': envelope(5, 'step.log', {
    stepId: 'step_01',
    stream: 'build',
    line: 'CC main.o',
  }),
  'step.log (batched)': envelope(6, 'step.log', {
    stepId: 'step_01',
    stream: 'serial',
    lines: ['TEMP=24.3 HUM=41.2', 'TEMP=24.4 HUM=41.1'],
  }),
  'step.completed': envelope(7, 'step.completed', {
    stepId: 'step_01',
    summary: 'Build succeeded.',
    artifactIds: ['art_01'],
  }),
  'step.failed': envelope(8, 'step.failed', {
    stepId: 'step_01',
    summary: 'Link failed.',
    artifactIds: ['art_01'],
  }),
  'artifact.created': envelope(9, 'artifact.created', { artifact: sampleArtifact }),
  'check.evaluated': envelope(10, 'check.evaluated', { check: sampleCheck }),
  'diagnosis.created': envelope(11, 'diagnosis.created', { diagnosis: sampleDiagnosis }),
  'approval.requested': envelope(12, 'approval.requested', { approval: sampleApproval }),
  'approval.resolved': envelope(13, 'approval.resolved', {
    approvalId: 'apr_01',
    status: 'approved',
    resolvedAt: TS,
  }),
  'run.completed': envelope(14, 'run.completed', {
    summary: 'All checks pass.',
    reportArtifactId: 'art_09',
  }),
  'run.failed': envelope(15, 'run.failed', { summary: 'Max iterations reached.' }),
  'run.stopped': envelope(16, 'run.stopped', { byUser: true }),
  'runner.status': envelope(17, 'runner.status', { bench: sampleBench }, '_global'),
};

describe('EventSchema round-trips', () => {
  for (const [name, event] of Object.entries(catalog)) {
    it(`round-trips ${name}`, () => {
      expect(EventSchema.parse(event)).toEqual(event);
      // JSON round-trip: what goes over the wire parses back identically.
      expect(EventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    });
  }
});

describe('EventSchema envelope rules', () => {
  it('rejects seq below 1', () => {
    const bad = { ...catalog['run.created'], seq: 0 };
    expect(() => EventSchema.parse(bad)).toThrow();
  });

  it('rejects a non-ISO ts', () => {
    const bad = { ...catalog['run.created'], ts: 'yesterday' };
    expect(() => EventSchema.parse(bad)).toThrow();
  });

  it('rejects unknown event types', () => {
    const unknown = { seq: 1, runId: 'run_01', ts: TS, type: 'run.paused', payload: {} };
    expect(() => EventSchema.parse(unknown)).toThrow();
  });

  it('accepts unknown event types via the forward-compatibility envelope', () => {
    const unknown = { seq: 1, runId: 'run_01', ts: TS, type: 'run.paused', payload: {} };
    expect(EventEnvelopeSchema.parse(unknown)).toEqual(unknown);
  });

  it('rejects run.stopped with byUser false', () => {
    const bad = { ...catalog['run.stopped'], payload: { byUser: false } };
    expect(() => EventSchema.parse(bad)).toThrow();
  });

  it('rejects a check without artifactId (evidence linking is law)', () => {
    const checkWithoutArtifact: Partial<typeof sampleCheck> = { ...sampleCheck };
    delete checkWithoutArtifact.artifactId;
    const bad = { ...catalog['check.evaluated'], payload: { check: checkWithoutArtifact } };
    expect(() => EventSchema.parse(bad)).toThrow();
  });
});
