import { describe, expect, it } from 'vitest';
import type { Event, WireEvent } from './events';
import { ProtocolError, reduceRun, type RunView } from './reducer';
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

// Every stream in these suites carries run.created, so the view always
// materializes. reduceRun's null return (a stream with no known event yet,
// T5.0 FIX_FIRST F1) has its own suite below and calls reduceRun directly.
function reduce(events: readonly WireEvent[]): RunView {
  const view = reduceRun(events);
  if (view === null) throw new Error('expected reduceRun to materialize a view');
  return view;
}

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
    const view = reduce(happyEvents());

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
    // step.log lines keep their stream (§5.2) — the per-stream log tabs route on it.
    expect(view.logsByStep.get('step_01')).toEqual([
      { stream: 'build', line: 'CC main.o' },
      { stream: 'build', line: 'LD firmware.elf' },
      { stream: 'build', line: 'text 9184 data 120 bss 1648' },
    ]);
    expect(view.iterations).toEqual([]);
    expect(view.riskSummary).toBe('One medium-risk hardware action (flash).');
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
    const view = reduce(events);
    expect(view.steps[0]).toMatchObject({ status: 'failed', summary: 'Link failed.' });
  });

  it('is pure: reducing twice gives equal views and never mutates input events', () => {
    const events = happyEvents();
    const first = reduce(events);
    const second = reduce(events);
    expect(second).toEqual(first);
    expect(events).toEqual(happyEvents());
  });

  it('throws a typed ProtocolError when a KNOWN-typed stream starts without run.created', () => {
    try {
      reduceRun([envelope(1, 'run.status_changed', { status: 'running' })]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe('missing_run');
    }
  });

  it('throws missing_run for every known type, not just the run.* events (step.log)', () => {
    // Before F1's fix this slipped through: step.log never touched `run`, so a
    // stream starting with it reduced without complaint and only threw at the end.
    expect(() =>
      reduceRun([
        envelope(1, 'step.log', { stepId: 'step_01', stream: 'build', line: 'CC main.o' }),
        envelope(2, 'run.created', { run: sampleRun }),
      ]),
    ).toThrow(ProtocolError);
  });
});

describe('reduceRun — endedAt (§5.4 v1.5)', () => {
  // A ts distinct from the shared TS proves endedAt comes from the terminal
  // event's own envelope, not from any other event in the stream.
  const END_TS = '2026-07-07T15:00:00.000Z';
  const preTerminal = () => happyEvents().slice(0, 10);

  it('is undefined while the run is non-terminal', () => {
    expect(reduce(preTerminal()).endedAt).toBeUndefined();
  });

  it('is set from the terminal event envelope ts for each terminal type', () => {
    const completed = [
      ...preTerminal(),
      { ...envelope(11, 'run.completed', { summary: 'done', reportArtifactId: 'art_01' }), ts: END_TS },
    ];
    expect(reduce(completed).endedAt).toBe(END_TS);

    const failed = [
      ...preTerminal(),
      { ...envelope(11, 'run.failed', { summary: 'max iterations reached' }), ts: END_TS },
    ];
    expect(reduce(failed).endedAt).toBe(END_TS);

    const stopped = [
      ...preTerminal(),
      { ...envelope(11, 'run.stopped', { byUser: true }), ts: END_TS },
    ];
    expect(reduce(stopped).endedAt).toBe(END_TS);
  });

  it('survives a duplicate of the terminal event (idempotent by seq)', () => {
    const terminal = { ...envelope(11, 'run.stopped', { byUser: true }), ts: END_TS };
    const events = [...preTerminal(), terminal];
    const duplicated = [...events, { ...terminal, ts: '2026-07-07T16:00:00.000Z' }];
    expect(reduce(duplicated).endedAt).toBe(END_TS);
    expect(reduce(duplicated)).toEqual(reduce(events));
  });

  it('is set from a run.status_changed carrying a terminal status', () => {
    const view = reduce([
      ...preTerminal(),
      { ...envelope(11, 'run.status_changed', { status: 'stopped' }), ts: END_TS },
    ]);
    expect(view.run.status).toBe('stopped');
    expect(view.endedAt).toBe(END_TS);
  });

  it('lets the dedicated terminal event take precedence over status_changed, in either order', () => {
    const STATUS_TS = '2026-07-07T14:59:59.000Z';
    const usual = reduce([
      ...preTerminal(),
      { ...envelope(11, 'run.status_changed', { status: 'stopped' }), ts: STATUS_TS },
      { ...envelope(12, 'run.stopped', { byUser: true }), ts: END_TS },
    ]);
    expect(usual.endedAt).toBe(END_TS);

    const reversed = reduce([
      ...preTerminal(),
      { ...envelope(11, 'run.stopped', { byUser: true }), ts: END_TS },
      { ...envelope(12, 'run.status_changed', { status: 'stopped' }), ts: STATUS_TS },
    ]);
    expect(reversed.endedAt).toBe(END_TS);
  });
});

describe('reduceRun — diagnosis fixApprovalId (§5.4 v1.6)', () => {
  const base = () => [
    envelope(1, 'run.created', { run: sampleRun }),
    envelope(2, 'artifact.created', { artifact: sampleArtifact }),
    envelope(3, 'check.evaluated', {
      check: { ...sampleCheck, id: 'chk_02', verdict: 'fail' as const },
    }),
  ];

  it('is undefined until an approval.requested follows the diagnosis', () => {
    const view = reduce([...base(), envelope(4, 'diagnosis.created', { diagnosis: sampleDiagnosis })]);
    expect(view.diagnosis?.fixApprovalId).toBeUndefined();
  });

  it('is the id of the first post-diagnosis approval.requested; later ones never overwrite', () => {
    const view = reduce([
      ...base(),
      envelope(4, 'diagnosis.created', { diagnosis: sampleDiagnosis }),
      envelope(5, 'approval.requested', { approval: { ...sampleApproval, id: 'apr_fix' } }),
      envelope(6, 'approval.requested', { approval: { ...sampleApproval, id: 'apr_other' } }),
    ]);
    expect(view.diagnosis?.fixApprovalId).toBe('apr_fix');
  });

  it('a pre-diagnosis approval never claims it', () => {
    const view = reduce([
      ...base(),
      envelope(4, 'approval.requested', { approval: { ...sampleApproval, id: 'apr_flash' } }),
      envelope(5, 'diagnosis.created', { diagnosis: sampleDiagnosis }),
      envelope(6, 'approval.requested', { approval: { ...sampleApproval, id: 'apr_fix' } }),
    ]);
    expect(view.diagnosis?.fixApprovalId).toBe('apr_fix');
  });

  it('survives duplicate-seq no-ops of the diagnosis and approval events', () => {
    const events = [
      ...base(),
      envelope(4, 'diagnosis.created', { diagnosis: sampleDiagnosis }),
      envelope(5, 'approval.requested', { approval: { ...sampleApproval, id: 'apr_fix' } }),
    ];
    const duplicated = [...events, events[3]!, events[4]!];
    expect(reduce(duplicated).diagnosis?.fixApprovalId).toBe('apr_fix');
    expect(reduce(duplicated)).toEqual(reduce(events));
  });
});

describe('reduceRun — diagnosis↔checks law (T2.2 review F5)', () => {
  it('records a warning for each cited check id with no prior check.evaluated', () => {
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'diagnosis.created', {
        diagnosis: { ...sampleDiagnosis, failedCheckIds: ['chk_ghost', 'chk_phantom'] },
      }),
    ]);
    expect(view.warnings).toHaveLength(2);
    expect(view.warnings[0]).toContain('chk_ghost');
    expect(view.warnings[1]).toContain('chk_phantom');
    // The diagnosis itself is kept, never dropped.
    expect(view.diagnosis?.failedCheckIds).toEqual(['chk_ghost', 'chk_phantom']);
  });

  it('records nothing when every cited check was evaluated first', () => {
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'artifact.created', { artifact: sampleArtifact }),
      envelope(3, 'check.evaluated', {
        check: { ...sampleCheck, id: 'chk_02', verdict: 'fail' as const },
      }),
      envelope(4, 'diagnosis.created', { diagnosis: sampleDiagnosis }),
    ]);
    expect(view.warnings).toEqual([]);
  });
});

describe('reduceRun — idempotency by seq', () => {
  it('treats a duplicate seq as a no-op', () => {
    const events = happyEvents();
    const duplicated = [...events.slice(0, 7), events[6]!, ...events.slice(7)];
    expect(reduce(duplicated)).toEqual(reduce(events));
    // Log lines are not double-applied.
    expect(reduce(duplicated).logsByStep.get('step_01')).toHaveLength(3);
  });

  it('treats a lower seq as a no-op', () => {
    const events = happyEvents();
    const replayed = [...events.slice(0, 9), events[5]!, ...events.slice(9)];
    expect(reduce(replayed)).toEqual(reduce(events));
  });
});

describe('reduceRun — gap detection', () => {
  it('throws a typed ProtocolError on a seq gap', () => {
    const events = happyEvents().filter((event) => event.seq !== 3);
    try {
      reduce(events);
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
    expect(() => reduce(events)).toThrow(ProtocolError);
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
    const view = reduce(approvalEvents('approved'));
    expect(view.approvals).toHaveLength(1);
    expect(view.approvals[0]).toMatchObject({ id: 'apr_01', status: 'approved', resolvedAt: TS });
    expect(view.run.status).toBe('running');
  });

  it('tracks requested → rejected and run.stopped', () => {
    const view = reduce(approvalEvents('rejected'));
    expect(view.approvals[0]).toMatchObject({ status: 'rejected', resolvedAt: TS });
    expect(view.run.status).toBe('stopped');
  });

  it('records a warning for a resolution of an unknown approval', () => {
    const view = reduce([
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
    const view = reduce(events);
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
    expect(reduce(duplicated)).toEqual(reduce(events));
    expect(reduce(duplicated).run.iteration).toBe(2);
  });

  it('records an IterationMarker with the index of the first iteration-2 step', () => {
    const iter2Step = { ...sampleRunStep, id: 'step_02', planIndex: 1 };
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'step.started', { step: sampleRunStep }),
      envelope(3, 'step.failed', { stepId: 'step_01', summary: 'NACK', artifactIds: [] }),
      envelope(4, 'run.iteration_started', { iteration: 2, reason: 'applying approved fix' }),
      envelope(5, 'step.started', { step: iter2Step }),
    ]);
    // firstStepIndex points at steps[1] — the first step started after the marker.
    expect(view.iterations).toEqual([
      { iteration: 2, reason: 'applying approved fix', firstStepIndex: 1 },
    ]);
    expect(view.steps[1]!.id).toBe('step_02');
  });

  it('places a marker with no subsequent steps yet at steps.length', () => {
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'step.started', { step: sampleRunStep }),
      envelope(3, 'run.iteration_started', { iteration: 2, reason: 'applying approved fix' }),
    ]);
    expect(view.iterations).toEqual([
      { iteration: 2, reason: 'applying approved fix', firstStepIndex: 1 },
    ]);
  });
});

describe('reduceRun — per-stream logs (BIBLE v1.4 §5.4)', () => {
  it('keeps each line tagged with its step.log stream', () => {
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'step.started', { step: sampleRunStep }),
      envelope(3, 'step.log', { stepId: 'step_01', stream: 'agent', line: 'Flashing…' }),
      envelope(4, 'step.log', { stepId: 'step_01', stream: 'flash', lines: ['Erased 2 sectors'] }),
      envelope(5, 'step.log', { stepId: 'step_01', stream: 'serial', line: 'TEMP=24.3' }),
    ]);
    expect(view.logsByStep.get('step_01')).toEqual([
      { stream: 'agent', line: 'Flashing…' },
      { stream: 'flash', line: 'Erased 2 sectors' },
      { stream: 'serial', line: 'TEMP=24.3' },
    ]);
  });
});

describe('reduceRun — riskSummary (BIBLE v1.3 §5.4)', () => {
  it('is undefined before run.plan_generated', () => {
    const view = reduce(happyEvents().slice(0, 1));
    expect(view.riskSummary).toBeUndefined();
  });

  it('is populated from run.plan_generated', () => {
    const view = reduce(happyEvents().slice(0, 2));
    expect(view.riskSummary).toBe('One medium-risk hardware action (flash).');
  });

  it('survives a duplicate-seq no-op of the plan_generated event', () => {
    const events = happyEvents();
    const duplicated = [...events.slice(0, 2), events[1]!, ...events.slice(2)];
    expect(reduce(duplicated).riskSummary).toBe('One medium-risk hardware action (flash).');
    expect(reduce(duplicated)).toEqual(reduce(events));
  });
});

describe('reduceRun — evidence-linking law', () => {
  it('downgrades a check whose artifact has no prior artifact.created', () => {
    const orphanCheck = envelope(2, 'check.evaluated', {
      check: { ...sampleCheck, artifactId: 'art_missing' },
    });
    const view = reduce([envelope(1, 'run.created', { run: sampleRun }), orphanCheck]);

    expect(view.checks).toHaveLength(1);
    expect(view.checks[0]!.verdict).toBe('needs_review');
    expect(view.warnings).toHaveLength(1);
    expect(view.warnings[0]).toContain('art_missing');
    // Purity: the event payload itself is untouched.
    expect(orphanCheck.payload.check.verdict).toBe('pass');
  });

  it('keeps the verdict when the artifact was created first', () => {
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'artifact.created', { artifact: sampleArtifact }),
      envelope(3, 'check.evaluated', { check: sampleCheck }),
    ]);
    expect(view.checks[0]!.verdict).toBe('pass');
    expect(view.warnings).toEqual([]);
  });

  it('re-evaluating a check with the same id replaces it (fix loop)', () => {
    const failed = { ...sampleCheck, verdict: 'fail' as const, actual: { value: false } };
    const view = reduce([
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

describe('reduceRun — ignored envelopes count toward continuity (§5.1, T5.0/F1)', () => {
  const unknownAt = (seq: number) =>
    ({
      seq,
      runId: 'run_01',
      ts: TS,
      type: 'run.paused',
      payload: { anything: true },
      ignored: true,
    }) as const;

  it('an unknown-typed envelope mid-stream advances lastSeq and carries no state', () => {
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      unknownAt(2),
      envelope(3, 'run.status_changed', { status: 'running' }),
    ]);
    expect(view.lastSeq).toBe(3);
    expect(view.run.status).toBe('running');
    expect(view.warnings).toEqual([]);
  });

  it('without the envelope, the same stream is a seq gap — the failure F1 fixes', () => {
    expect(() =>
      reduce([
        envelope(1, 'run.created', { run: sampleRun }),
        envelope(3, 'run.status_changed', { status: 'running' }),
      ]),
    ).toThrow(ProtocolError);
  });

  it('a known-typed envelope with a non-conforming payload is equally inert', () => {
    // parseWireEvent tags these ignored rather than letting the reducer read
    // fields that are not there; the reducer must treat them as seq-only.
    const malformed = {
      seq: 2,
      runId: 'run_01',
      ts: TS,
      type: 'run.completed',
      payload: {},
      ignored: true,
    } as const;
    const view = reduce([envelope(1, 'run.created', { run: sampleRun }), malformed]);
    expect(view.lastSeq).toBe(2);
    // Crucially it did NOT complete the run.
    expect(view.run.status).toBe(sampleRun.status);
    expect(view.endedAt).toBeUndefined();
  });

  // §5.2 does not promise run.created is seq 1 — the envelope-first rule means an
  // ignored envelope can legally occupy it (T5.0 FIX_FIRST F1).
  it('tolerates an ignored envelope at seq 1: run.created at seq 2 materializes the view', () => {
    const view = reduce([
      unknownAt(1),
      { ...envelope(1, 'run.created', { run: sampleRun }), seq: 2 },
      { ...envelope(1, 'run.status_changed', { status: 'running' }), seq: 3 },
    ]);
    expect(view.run.id).toBe(sampleRun.id);
    expect(view.run.status).toBe('running');
    expect(view.lastSeq).toBe(3);
    expect(view.warnings).toEqual([]);
  });

  it('reduces a stream of ONLY ignored envelopes to null — a valid, empty view, no throw', () => {
    expect(reduceRun([unknownAt(1), unknownAt(2), unknownAt(3)])).toBeNull();
  });

  it('reduces an empty stream to null', () => {
    expect(reduceRun([])).toBeNull();
  });
});

describe('reduceRun — legal-ordering reconciliation (T5.0/F5)', () => {
  it('a check downgraded needs_review upgrades when its artifact lands', () => {
    const early = [
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'check.evaluated', { check: sampleCheck }),
    ];
    // The prefix truthfully reports the violation-in-progress…
    const before = reduce(early);
    expect(before.checks[0]!.verdict).toBe('needs_review');
    expect(before.warnings).toHaveLength(1);

    // …and the artifact dissolves it: verdict restored, warning gone.
    const after = reduce([
      ...early,
      envelope(3, 'artifact.created', { artifact: sampleArtifact }),
    ]);
    expect(after.checks).toHaveLength(1);
    expect(after.checks[0]!.verdict).toBe('pass');
    expect(after.warnings).toEqual([]);
  });

  it('re-resolution restores the LATEST wire verdict for a re-evaluated pending check', () => {
    const failed = { ...sampleCheck, verdict: 'fail' as const, actual: { value: false } };
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'check.evaluated', { check: sampleCheck }),
      envelope(3, 'check.evaluated', { check: failed }),
      envelope(4, 'artifact.created', { artifact: sampleArtifact }),
    ]);
    expect(view.checks).toHaveLength(1);
    expect(view.checks[0]!.verdict).toBe('fail');
    expect(view.warnings).toEqual([]);
  });

  it('a check whose artifact never arrives stays needs_review with the warning', () => {
    const orphan = { ...sampleCheck, artifactId: 'art_never' };
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'check.evaluated', { check: orphan }),
      envelope(3, 'artifact.created', { artifact: sampleArtifact }), // a different artifact
    ]);
    expect(view.checks[0]!.verdict).toBe('needs_review');
    expect(view.warnings).toHaveLength(1);
    expect(view.warnings[0]).toContain('art_never');
  });

  it('an early step.completed is buffered and reconciled by step.started, not dropped', () => {
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      { ...envelope(2, 'step.completed', {
        stepId: 'step_01',
        summary: 'Build succeeded.',
        artifactIds: ['art_01'],
      }), ts: '2026-07-07T14:05:30.312Z' },
      envelope(3, 'step.started', { step: sampleRunStep }),
    ]);
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]!.status).toBe('succeeded');
    expect(view.steps[0]!.summary).toBe('Build succeeded.');
    expect(view.steps[0]!.artifactIds).toEqual(['art_01']);
    // endedAt comes from the OUTCOME event's envelope ts, as in the normal order.
    expect(view.steps[0]!.endedAt).toBe('2026-07-07T14:05:30.312Z');
    expect(view.warnings).toEqual([]);
  });

  it('an early step.failed reconciles to a failed step', () => {
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'step.failed', { stepId: 'step_01', summary: 'Link failed.', artifactIds: [] }),
      envelope(3, 'step.started', { step: sampleRunStep }),
    ]);
    expect(view.steps[0]!.status).toBe('failed');
    expect(view.warnings).toEqual([]);
  });

  it('a step outcome that never finds its step remains a warning', () => {
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'step.completed', { stepId: 'step_ghost', summary: 'x', artifactIds: [] }),
    ]);
    expect(view.steps).toHaveLength(0);
    expect(view.warnings).toHaveLength(1);
    expect(view.warnings[0]).toContain('step_ghost');
  });

  it('an early approval.resolved is buffered and reconciled by approval.requested', () => {
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'approval.resolved', {
        approvalId: sampleApproval.id,
        status: 'approved',
        resolvedAt: TS,
      }),
      envelope(3, 'approval.requested', { approval: sampleApproval }),
    ]);
    expect(view.approvals).toHaveLength(1);
    expect(view.approvals[0]!.status).toBe('approved');
    expect(view.approvals[0]!.resolvedAt).toBe(TS);
    expect(view.warnings).toEqual([]);
  });

  it('an early resolution still lets the approval claim fixApprovalId', () => {
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'diagnosis.created', { diagnosis: { ...sampleDiagnosis, failedCheckIds: [] } }),
      envelope(3, 'approval.resolved', {
        approvalId: sampleApproval.id,
        status: 'approved',
        resolvedAt: TS,
      }),
      envelope(4, 'approval.requested', { approval: sampleApproval }),
    ]);
    expect(view.diagnosis?.fixApprovalId).toBe(sampleApproval.id);
    expect(view.approvals[0]!.status).toBe('approved');
  });

  it('a resolution that never finds its approval remains a warning', () => {
    const view = reduce([
      envelope(1, 'run.created', { run: sampleRun }),
      envelope(2, 'approval.resolved', { approvalId: 'apr_ghost', status: 'rejected', resolvedAt: TS }),
    ]);
    expect(view.approvals).toHaveLength(0);
    expect(view.warnings).toHaveLength(1);
    expect(view.warnings[0]).toContain('apr_ghost');
  });
});
