// The contract-owned reducer — BIBLE §5.4. Pure and deterministic: the UI NEVER
// derives run state any other way. Reconnect, history, and mock replay are all
// this one code path.
import type {
  Approval,
  Artifact,
  Diagnosis,
  MeasurementCheck,
  Run,
  RunStatus,
  RunStep,
} from './entities';
import {
  isKnownEvent,
  type CheckExpectation,
  type Event,
  type StepLogStream,
  type WireEvent,
} from './events';

// RunView's diagnosis carries the reducer-derived link to its fix approval: the id
// of the first approval.requested whose seq follows the diagnosis.created (§5.4
// v1.6); undefined until that approval arrives. The wire Diagnosis is unchanged.
export interface DiagnosisView extends Diagnosis {
  fixApprovalId?: string;
}

// One step.log line with the stream it arrived on (§5.2) — the per-stream log tabs
// in the workspace route on this. `ts` is the emitting event's envelope ts (§5.1):
// a batched step.log (payload.lines) shares one ts across its lines, since the
// contract times events, not individual lines. The workspace LogViewer surfaces it
// as the optional per-line timestamp column (T6.2).
export interface StepLogLine {
  stream: StepLogStream;
  line: string;
  ts: string;
}

// Where a fix-loop iteration begins in the step list (from run.iteration_started,
// emitted for iteration >= 2 only). firstStepIndex is the index into steps[] of the
// first step of this iteration — steps.length at the moment the event arrived.
export interface IterationMarker {
  iteration: number;
  reason: string;
  firstStepIndex: number;
}

export interface RunView {
  run: Run;
  steps: RunStep[];
  artifacts: Artifact[];
  checks: MeasurementCheck[];
  approvals: Approval[];
  diagnosis?: DiagnosisView;
  // From run.plan_generated (§5.2); undefined before the plan exists.
  riskSummary?: string;
  // The plan's declared check registry (run.plan_generated.checks, v2.4);
  // undefined when the producer declared none — a consumer must then report
  // coverage without a denominator, never invent one.
  registeredChecks?: CheckExpectation[];
  // The terminal event's summary (run.completed / run.failed), or a terminal
  // run.status_changed's reason when no dedicated terminal event carried one
  // (v2.4, reducer-only — the "why it ended" beside endedAt's "when").
  terminalSummary?: string;
  // Envelope ts of the terminal event (run.completed / run.failed / run.stopped,
  // or a run.status_changed carrying a terminal status — the dedicated terminal
  // events take precedence); undefined while non-terminal (§5.4 v1.5).
  endedAt?: string;
  logsByStep: Map<string, StepLogLine[]>;
  // Fix-loop iteration boundaries, ordered; empty until run.iteration_started.
  iterations: IterationMarker[];
  lastSeq: number;
  // Contract violations observed while reducing (e.g. the evidence-linking law).
  warnings: string[];
}

export type ProtocolErrorCode = 'seq_gap' | 'missing_run';

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly seq?: number;
  readonly expectedSeq?: number;

  constructor(
    code: ProtocolErrorCode,
    message: string,
    details: { seq?: number; expectedSeq?: number } = {},
  ) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.seq = details.seq;
    this.expectedSeq = details.expectedSeq;
  }
}

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'stopped']);

function upsertById<T extends { id: string }>(items: T[], item: T): void {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) {
    items.push(item);
  } else {
    items[index] = item;
  }
}

// Returns null — the valid, empty view — when the stream carries no known event
// yet (empty, or only ignored envelopes preceding run.created); throws missing_run
// only when a KNOWN-typed event arrives before run.created (T5.0 FIX_FIRST F1).
export function reduceRun(events: readonly WireEvent[]): RunView | null {
  let run: Run | undefined;
  let diagnosis: DiagnosisView | undefined;
  let riskSummary: string | undefined;
  let registeredChecks: CheckExpectation[] | undefined;
  let terminalSummary: string | undefined;
  let endedAt: string | undefined;
  // True once a dedicated terminal event set endedAt; a run.status_changed with a
  // terminal status never overrides it.
  let endedAtFromTerminalEvent = false;
  const steps: RunStep[] = [];
  const artifacts: Artifact[] = [];
  const checks: MeasurementCheck[] = [];
  const approvals: Approval[] = [];
  const logsByStep = new Map<string, StepLogLine[]>();
  const iterations: IterationMarker[] = [];
  const warnings: string[] = [];
  const knownArtifactIds = new Set<string>();
  let lastSeq = 0;

  // Legal-ordering buffers (T5.0/F5): an event that references an entity which has
  // not arrived yet is buffered and reconciled when it does — never dropped. seq is
  // per-run and ordered, but nothing in §5.2 promises an artifact.created lands
  // before the check that cites it, a step.started before its outcome, or an
  // approval.requested before its resolution. Whatever is still pending when this
  // reduction ends becomes a contract warning (see the end of this function) — so a
  // mid-stream prefix truthfully reports the violation-in-progress, and the very
  // next event can dissolve it.
  const pendingChecks = new Map<string, { check: MeasurementCheck; seq: number }>();
  const pendingStepOutcomes = new Map<
    string,
    { type: 'step.completed' | 'step.failed'; summary: string; artifactIds: string[]; ts: string; seq: number }
  >();
  const pendingApprovalResolutions = new Map<
    string,
    { status: Approval['status']; resolvedAt: string; seq: number }
  >();

  const applyStepOutcome = (
    index: number,
    outcome: { type: 'step.completed' | 'step.failed'; summary: string; artifactIds: string[]; ts: string },
  ): void => {
    const step = steps[index] as RunStep;
    steps[index] = {
      ...step,
      status: outcome.type === 'step.completed' ? 'succeeded' : 'failed',
      summary: outcome.summary,
      artifactIds: outcome.artifactIds,
      // step.completed/step.failed carries no step object, so the envelope ts is
      // the only source for endedAt.
      endedAt: outcome.ts,
    };
  };

  // Narrowing accessor for the cases below; the guard in the loop has already
  // thrown for any known event that could reach one of them before run.created.
  const requireRun = (event: Event): Run => {
    if (!run) {
      throw new ProtocolError(
        'missing_run',
        `event "${event.type}" (seq ${event.seq}) arrived before run.created`,
        { seq: event.seq },
      );
    }
    return run;
  };

  for (const wire of events) {
    // Idempotent by seq: a duplicate or lower seq is a no-op (§5.4).
    if (wire.seq <= lastSeq) {
      continue;
    }
    // seq is monotonic per run, starts at 1, no gaps — a gap is a protocol error
    // and the caller re-fetches via HTTP replay (§5.1).
    if (wire.seq !== lastSeq + 1) {
      throw new ProtocolError(
        'seq_gap',
        `seq gap: expected ${lastSeq + 1}, got ${wire.seq} (${wire.type})`,
        { seq: wire.seq, expectedSeq: lastSeq + 1 },
      );
    }
    lastSeq = wire.seq;

    // An ignored envelope (unknown type, or a payload the catalog parse rejected)
    // has now done its one job — advancing seq continuity — and carries no state
    // (§5.1 forward compatibility, T5.0/F1).
    if (!isKnownEvent(wire)) {
      continue;
    }
    const event = wire;

    // A KNOWN-typed stream that starts wrong is a protocol error, whatever the
    // event: run state must originate in run.created, never be back-filled. (An
    // IGNORED envelope before run.created is fine — it advanced seq above and
    // asserts nothing about the run; see the end of this function.)
    if (!run && event.type !== 'run.created') {
      throw new ProtocolError(
        'missing_run',
        `event "${event.type}" (seq ${event.seq}) arrived before run.created`,
        { seq: event.seq },
      );
    }

    switch (event.type) {
      case 'run.created': {
        run = event.payload.run;
        break;
      }
      case 'run.plan_generated': {
        run = { ...requireRun(event), plan: event.payload.plan };
        riskSummary = event.payload.riskSummary;
        registeredChecks = event.payload.checks;
        break;
      }
      case 'run.status_changed': {
        run = { ...requireRun(event), status: event.payload.status };
        if (TERMINAL_STATUSES.has(event.payload.status) && !endedAtFromTerminalEvent) {
          endedAt = event.ts;
          // The transition's reason is the terminal summary only until a
          // dedicated terminal event states its own (which takes precedence,
          // same rule as endedAt).
          if (event.payload.reason !== undefined) {
            terminalSummary = event.payload.reason;
          }
        }
        break;
      }
      case 'step.started': {
        const { step } = event.payload;
        upsertById(steps, step);
        // A buffered early outcome reconciles the moment its step exists (F5).
        const buffered = pendingStepOutcomes.get(step.id);
        if (buffered) {
          pendingStepOutcomes.delete(step.id);
          applyStepOutcome(
            steps.findIndex((existing) => existing.id === step.id),
            buffered,
          );
        }
        break;
      }
      case 'step.log': {
        const { payload } = event;
        const rawLines = 'lines' in payload ? payload.lines : [payload.line];
        const lines = rawLines.map((line) => ({ stream: payload.stream, line, ts: event.ts }));
        const existing = logsByStep.get(payload.stepId);
        if (existing) {
          existing.push(...lines);
        } else {
          logsByStep.set(payload.stepId, lines);
        }
        break;
      }
      case 'step.completed':
      case 'step.failed': {
        const { stepId, summary, artifactIds } = event.payload;
        const outcome = { type: event.type, summary, artifactIds, ts: event.ts, seq: event.seq };
        const index = steps.findIndex((step) => step.id === stepId);
        if (index === -1) {
          // Early outcome: buffer until step.started introduces the step (F5).
          pendingStepOutcomes.set(stepId, outcome);
          break;
        }
        pendingStepOutcomes.delete(stepId);
        applyStepOutcome(index, outcome);
        break;
      }
      case 'artifact.created': {
        const { artifact } = event.payload;
        upsertById(artifacts, artifact);
        knownArtifactIds.add(artifact.id);
        // The evidence law re-resolves (F5): a check downgraded to needs_review
        // because this artifact had not arrived yet gets its verdict back now.
        for (const [checkId, pending] of pendingChecks) {
          if (pending.check.artifactId === artifact.id) {
            pendingChecks.delete(checkId);
            upsertById(checks, pending.check);
          }
        }
        break;
      }
      case 'check.evaluated': {
        const { check } = event.payload;
        // Evidence-linking law (§4): a check whose artifactId is not resolvable is
        // needs_review in the view. Not resolvable YET is not dropped-for-good:
        // the wire verdict is buffered and restored if the artifact lands (F5);
        // still unresolved at the end of the stream, it becomes the warning.
        if (knownArtifactIds.has(check.artifactId)) {
          pendingChecks.delete(check.id);
          upsertById(checks, check);
        } else {
          pendingChecks.set(check.id, { check, seq: event.seq });
          upsertById(checks, { ...check, verdict: 'needs_review' });
        }
        break;
      }
      case 'diagnosis.created': {
        const created = event.payload.diagnosis;
        // Diagnosis↔checks law (parallel to evidence linking): every cited failed
        // check must already exist in view.checks; a miss is recorded, never dropped.
        const knownCheckIds = new Set(checks.map((check) => check.id));
        for (const checkId of created.failedCheckIds) {
          if (!knownCheckIds.has(checkId)) {
            warnings.push(
              `contract violation: diagnosis "${created.id}" (seq ${event.seq}) ` +
                `references check "${checkId}" with no prior check.evaluated`,
            );
          }
        }
        // A fresh diagnosis carries no fixApprovalId — the next approval.requested
        // claims it (§5.4 v1.6).
        diagnosis = created;
        break;
      }
      case 'approval.requested': {
        const { approval } = event.payload;
        upsertById(approvals, approval);
        // §5.4 v1.6: the first approval requested after diagnosis.created is that
        // diagnosis's fix approval; earlier approvals can never claim it because
        // events reduce in seq order and the diagnosis does not exist yet.
        if (diagnosis && diagnosis.fixApprovalId === undefined) {
          diagnosis = { ...diagnosis, fixApprovalId: approval.id };
        }
        // A buffered early resolution reconciles now (F5): the human's decision
        // arrived before the request did, but it is still the decision.
        const buffered = pendingApprovalResolutions.get(approval.id);
        if (buffered) {
          pendingApprovalResolutions.delete(approval.id);
          upsertById(approvals, {
            ...approval,
            status: buffered.status,
            resolvedAt: buffered.resolvedAt,
          });
        }
        break;
      }
      case 'approval.resolved': {
        const { approvalId, status, resolvedAt } = event.payload;
        const index = approvals.findIndex((approval) => approval.id === approvalId);
        const approval = index === -1 ? undefined : approvals[index];
        if (!approval) {
          // Early resolution: buffer until approval.requested introduces it (F5).
          pendingApprovalResolutions.set(approvalId, { status, resolvedAt, seq: event.seq });
          break;
        }
        pendingApprovalResolutions.delete(approvalId);
        approvals[index] = { ...approval, status, resolvedAt };
        break;
      }
      case 'run.iteration_started': {
        run = { ...requireRun(event), iteration: event.payload.iteration };
        iterations.push({
          iteration: event.payload.iteration,
          reason: event.payload.reason,
          firstStepIndex: steps.length,
        });
        break;
      }
      case 'run.completed': {
        run = { ...requireRun(event), status: 'completed' };
        endedAt = event.ts;
        endedAtFromTerminalEvent = true;
        terminalSummary = event.payload.summary;
        break;
      }
      case 'run.failed': {
        run = { ...requireRun(event), status: 'failed' };
        endedAt = event.ts;
        endedAtFromTerminalEvent = true;
        terminalSummary = event.payload.summary;
        break;
      }
      case 'run.stopped': {
        run = { ...requireRun(event), status: 'stopped' };
        endedAt = event.ts;
        endedAtFromTerminalEvent = true;
        break;
      }
      case 'runner.status': {
        // Bench-level event (runId "_global"); carries no per-run state.
        break;
      }
    }
  }

  // No known event yet (empty stream, or only ignored envelopes — a legal prefix
  // when run.created is not seq 1, §5.1/T5.0 FIX_FIRST F1): a valid, empty view.
  // Nothing below can have accumulated — every state-carrying case is guarded by
  // the missing_run throw above.
  if (!run) {
    return null;
  }

  // Whatever the stream never reconciled is a real contract violation (F5): the
  // buffered originals above were the benefit of the doubt, this is the verdict.
  for (const { check, seq } of pendingChecks.values()) {
    warnings.push(
      `evidence-linking violation: check "${check.id}" (${check.requirementId}, seq ${seq}) ` +
        `references artifact "${check.artifactId}" with no prior artifact.created; ` +
        `verdict marked needs_review`,
    );
  }
  for (const [stepId, outcome] of pendingStepOutcomes) {
    warnings.push(
      `contract violation: ${outcome.type} (seq ${outcome.seq}) references unknown step "${stepId}"`,
    );
  }
  for (const [approvalId, resolution] of pendingApprovalResolutions) {
    warnings.push(
      `contract violation: approval.resolved (seq ${resolution.seq}) references unknown approval "${approvalId}"`,
    );
  }

  return {
    run,
    steps,
    artifacts,
    checks,
    approvals,
    diagnosis,
    riskSummary,
    registeredChecks,
    terminalSummary,
    endedAt,
    logsByStep,
    iterations,
    lastSeq,
    warnings,
  };
}
