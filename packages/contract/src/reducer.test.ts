import { describe, expect, it } from 'vitest';
import type { Event } from './events';
import { ProtocolError, reduceRun } from './reducer';
import {
  envelope,
  sampleApproval,
  sampleArtifact,
  sampleCheck,
  sampleDiagnosis,
  samplePlanStep,
  sampleRun,
  sampleRunStep,
  TS,
} from './test-samples';

// The full happy path: plan → approval → step with logs/artifact → check → completed.
function happyEvents(): Event[] {
  return [
    envelope(1, 'run.created', { run: sampleRun }),
    envelope(2, 'run.plan_generated', {
      plan: [samplePlanStep],
      riskSummary: 'One medium-risk hardware action (flash).',
    }),
    envelope(3, 'run.status_changed', { status: 'plan_ready' }),
    envelope(4, 'run.status_changed', { status: 'running', reason: 'plan approved' }),
    envelope(5, 'step.started', { step: sampleRunStep }),
    envelope(6, 'step.log', { stepId: 'step_01', stream: 'build', line: 'CC main.o' }),
    envelope(7, 'step.log', {
      stepId: 'step_01',
      stream: 'build',
      lines: ['LD firmware.elf', 'text 9184 data 120 bss 1648'],
    }),
    envelope(8, 'artifact.created', { artifact: sampleArtifact }),
    envelope(9, 'step.completed', {
      stepId: 'step_01',
      summary: 'Build succeeded.',
      artifactIds: ['art_01'],
    }),
    envelope(10, 'check.evaluated', { check: sampleCheck }),
    envelope(11, 'run.completed', { summary: 'All checks pass.', reportArtifactId: 'art_01' }),
  ];
}

describe('reduceRun — happy transition sequence', () => {
  it('reduces the full sequence into a RunView', () => {
    const view = reduceRun(happyEvents());

    expect(view.run.id).toBe('run_01');
    expect(view.run.status).toBe('completed');
    expect(view.run.plan).toEqual([samplePlanStep]);
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]).toMatchObject({
      id: 'step_01',
      status: 'succeeded',
      summary: 'Build succeeded.',
      artifactIds: ['art_01'],
      endedAt: TS,
    });
    expect(view.artifacts).toEqual([sampleArtifact]);
    expect(view.checks).toEqual([sampleCheck]);
    expect(view.logsByStep.get('step_01')).toEqual([
      'CC main.o',
      'LD firmware.elf',
      'text 9184 data 120 bss 1648',
    ]);
    expect(view.lastSeq).toBe(11);
    expect(view.warnings).toEqual([]);
  });

  it('marks a failed step failed', () => {
    const events = happyEvents().slice(0, 8);
    events.push(
      envelope(9, 'step.failed', {
        stepId: 'step_01',
        summary: 'Link failed.',
        artifactIds: ['art_01'],
      }),
    );
    const view = reduceRun(events);
    expect(view.steps[0]).toMatchObject({ status: 'failed', summary: 'Link failed.' });
  });

  it('is pure: reducing twice gives equal views and never mutates input events', () => {
    const events = happyEvents();
    const first = reduceRun(events);
    const second = reduceRun(events);
    expect(second).toEqual(first);
    expect(events).toEqual(happyEvents());
  });

  it('throws a typed ProtocolError when the stream has no run.created', () => {
    expect(() => reduceRun([])).toThrow(ProtocolError);
    try {
      reduceRun([envelope(1, 'run.status_changed', { status: 'running' })]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe('missing_run');
    }
  });
});

describe('reduceRun — idempotency by seq', () => {
  it('treats a duplicate seq as a no-op', () => {
    const events = happyEvents();
    const duplicated = [...events.slice(0, 7), events[6]!, ...events.slice(7)];
    expect(reduceRun(duplicated)).toEqual(reduceRun(events));
    // Log lines are not double-applied.
    expect(reduceRun(duplicated).logsByStep.get('step_01')).toHaveLength(3);
  });

  it('treats a lower seq as a no-op', () => {
    const events = happyEvents();
    const replayed = [...events.slice(0, 9), events[5]!, ...events.slice(9)];
    expect(reduceRun(replayed)).toEqual(reduceRun(events));
  });
});

describe('reduceRun — gap detection', () => {
  it('throws a typed ProtocolError on a seq gap', () => {
    const events = happyEvents().filter((event) => event.seq !== 3);
    try {
      reduceRun(events);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      const protocolError = error as ProtocolError;
      expect(protocolError.code).toBe('seq_gap');
      expect(protocolError.expectedSeq).toBe(3);
      expect(protocolError.seq).toBe(4);
    }
  });

  it('throws when the stream does not start at seq 1', () => {
    const events = happyEvents().slice(1);
    expect(() => reduceRun(events)).toThrow(ProtocolError);
  });
});

describe('reduceRun — approval lifecycle', () => {
  function approvalEvents(decision: 'approved' | 'rejected'): Event[] {
    const events: Event[] = [
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'run.status_changed', { status: 'awaiting_approval' }),
      envelope(3, 'approval.requested', { approval: sampleApproval }),
      envelope(4, 'approval.resolved', { approvalId: 'apr_01', status: decision, resolvedAt: TS }),
    ];
    events.push(
      decision === 'approved'
        ? envelope(5, 'run.status_changed', { status: 'running' })
        : envelope(5, 'run.stopped', { byUser: true }),
    );
    return events;
  }

  it('tracks requested → approved', () => {
    const view = reduceRun(approvalEvents('approved'));
    expect(view.approvals).toHaveLength(1);
    expect(view.approvals[0]).toMatchObject({ id: 'apr_01', status: 'approved', resolvedAt: TS });
    expect(view.run.status).toBe('running');
  });

  it('tracks requested → rejected and run.stopped', () => {
    const view = reduceRun(approvalEvents('rejected'));
    expect(view.approvals[0]).toMatchObject({ status: 'rejected', resolvedAt: TS });
    expect(view.run.status).toBe('stopped');
  });

  it('records a warning for a resolution of an unknown approval', () => {
    const view = reduceRun([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'approval.resolved', {
        approvalId: 'apr_ghost',
        status: 'approved',
        resolvedAt: TS,
      }),
    ]);
    expect(view.approvals).toEqual([]);
    expect(view.warnings).toHaveLength(1);
    expect(view.warnings[0]).toContain('apr_ghost');
  });
});

describe('reduceRun — fix-loop iteration', () => {
  it('reaches iteration 2 via run.iteration_started', () => {
    const events: Event[] = [
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'run.status_changed', { status: 'diagnosing' }),
      envelope(3, 'run.iteration_started', { iteration: 2, reason: 'applying approved fix' }),
      envelope(4, 'run.status_changed', { status: 'running' }),
    ];
    const view = reduceRun(events);
    expect(view.run.iteration).toBe(2);
    expect(view.run.status).toBe('running');
    expect(view.warnings).toEqual([]);
  });

  it('applies the duplicate-seq no-op rule to run.iteration_started', () => {
    const events: Event[] = [
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'run.iteration_started', { iteration: 2, reason: 'applying approved fix' }),
    ];
    const duplicated = [...events, events[1]!];
    expect(reduceRun(duplicated)).toEqual(reduceRun(events));
    expect(reduceRun(duplicated).run.iteration).toBe(2);
  });
});

describe('reduceRun — evidence-linking law', () => {
  it('downgrades a check whose artifact has no prior artifact.created', () => {
    const orphanCheck = envelope(2, 'check.evaluated', {
      check: { ...sampleCheck, artifactId: 'art_missing' },
    });
    const view = reduceRun([envelope(1, 'run.created', { run: sampleRun }), orphanCheck]);

    expect(view.checks).toHaveLength(1);
    expect(view.checks[0]!.verdict).toBe('needs_review');
    expect(view.warnings).toHaveLength(1);
    expect(view.warnings[0]).toContain('art_missing');
    // Purity: the event payload itself is untouched.
    expect(orphanCheck.payload.check.verdict).toBe('pass');
  });

  it('keeps the verdict when the artifact was created first', () => {
    const view = reduceRun([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'artifact.created', { artifact: sampleArtifact }),
      envelope(3, 'check.evaluated', { check: sampleCheck }),
    ]);
    expect(view.checks[0]!.verdict).toBe('pass');
    expect(view.warnings).toEqual([]);
  });

  it('re-evaluating a check with the same id replaces it (fix loop)', () => {
    const failed = { ...sampleCheck, verdict: 'fail' as const, actual: { value: false } };
    const view = reduceRun([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'artifact.created', { artifact: sampleArtifact }),
      envelope(3, 'check.evaluated', { check: failed }),
      envelope(4, 'diagnosis.created', { diagnosis: sampleDiagnosis }),
      envelope(5, 'check.evaluated', { check: sampleCheck }),
    ]);
    expect(view.checks).toHaveLength(1);
    expect(view.checks[0]!.verdict).toBe('pass');
    expect(view.diagnosis).toEqual(sampleDiagnosis);
  });
});
