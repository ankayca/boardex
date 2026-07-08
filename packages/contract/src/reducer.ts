// The contract-owned reducer — BIBLE §5.4. Pure and deterministic: the UI NEVER
// derives run state any other way. Reconnect, history, and mock replay are all
// this one code path.
import type { Approval, Artifact, Diagnosis, MeasurementCheck, Run, RunStep } from './entities';
import type { Event, StepLogStream } from './events';

// One step.log line with the stream it arrived on (§5.2) — the per-stream log tabs
// in the workspace route on this.
export interface StepLogLine {
  stream: StepLogStream;
  line: string;
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
  diagnosis?: Diagnosis;
  // From run.plan_generated (§5.2); undefined before the plan exists.
  riskSummary?: string;
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

function upsertById<T extends { id: string }>(items: T[], item: T): void {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) {
    items.push(item);
  } else {
    items[index] = item;
  }
}

export function reduceRun(events: readonly Event[]): RunView {
  let run: Run | undefined;
  let diagnosis: Diagnosis | undefined;
  let riskSummary: string | undefined;
  const steps: RunStep[] = [];
  const artifacts: Artifact[] = [];
  const checks: MeasurementCheck[] = [];
  const approvals: Approval[] = [];
  const logsByStep = new Map<string, StepLogLine[]>();
  const iterations: IterationMarker[] = [];
  const warnings: string[] = [];
  const knownArtifactIds = new Set<string>();
  let lastSeq = 0;

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

  for (const event of events) {
    // Idempotent by seq: a duplicate or lower seq is a no-op (§5.4).
    if (event.seq <= lastSeq) {
      continue;
    }
    // seq is monotonic per run, starts at 1, no gaps — a gap is a protocol error
    // and the caller re-fetches via HTTP replay (§5.1).
    if (event.seq !== lastSeq + 1) {
      throw new ProtocolError(
        'seq_gap',
        `seq gap: expected ${lastSeq + 1}, got ${event.seq} (${event.type})`,
        { seq: event.seq, expectedSeq: lastSeq + 1 },
      );
    }
    lastSeq = event.seq;

    switch (event.type) {
      case 'run.created': {
        run = event.payload.run;
        break;
      }
      case 'run.plan_generated': {
        run = { ...requireRun(event), plan: event.payload.plan };
        riskSummary = event.payload.riskSummary;
        break;
      }
      case 'run.status_changed': {
        run = { ...requireRun(event), status: event.payload.status };
        break;
      }
      case 'step.started': {
        upsertById(steps, event.payload.step);
        break;
      }
      case 'step.log': {
        const { payload } = event;
        const rawLines = 'lines' in payload ? payload.lines : [payload.line];
        const lines = rawLines.map((line) => ({ stream: payload.stream, line }));
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
        const index = steps.findIndex((step) => step.id === stepId);
        const step = index === -1 ? undefined : steps[index];
        if (!step) {
          warnings.push(
            `contract violation: ${event.type} (seq ${event.seq}) references unknown step "${stepId}"`,
          );
          break;
        }
        steps[index] = {
          ...step,
          status: event.type === 'step.completed' ? 'succeeded' : 'failed',
          summary,
          artifactIds,
          // step.completed/step.failed carries no step object, so the envelope
          // ts is the only source for endedAt.
          endedAt: event.ts,
        };
        break;
      }
      case 'artifact.created': {
        upsertById(artifacts, event.payload.artifact);
        knownArtifactIds.add(event.payload.artifact.id);
        break;
      }
      case 'check.evaluated': {
        const { check } = event.payload;
        // Evidence-linking law (§4): a check whose artifactId has no prior
        // artifact.created is downgraded to needs_review, with a warning.
        if (knownArtifactIds.has(check.artifactId)) {
          upsertById(checks, check);
        } else {
          upsertById(checks, { ...check, verdict: 'needs_review' });
          warnings.push(
            `evidence-linking violation: check "${check.id}" (${check.requirementId}, seq ${event.seq}) ` +
              `references artifact "${check.artifactId}" with no prior artifact.created; ` +
              `verdict marked needs_review`,
          );
        }
        break;
      }
      case 'diagnosis.created': {
        diagnosis = event.payload.diagnosis;
        break;
      }
      case 'approval.requested': {
        upsertById(approvals, event.payload.approval);
        break;
      }
      case 'approval.resolved': {
        const { approvalId, status, resolvedAt } = event.payload;
        const index = approvals.findIndex((approval) => approval.id === approvalId);
        const approval = index === -1 ? undefined : approvals[index];
        if (!approval) {
          warnings.push(
            `contract violation: approval.resolved (seq ${event.seq}) references unknown approval "${approvalId}"`,
          );
          break;
        }
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
        break;
      }
      case 'run.failed': {
        run = { ...requireRun(event), status: 'failed' };
        break;
      }
      case 'run.stopped': {
        run = { ...requireRun(event), status: 'stopped' };
        break;
      }
      case 'runner.status': {
        // Bench-level event (runId "_global"); carries no per-run state.
        break;
      }
      default: {
        // Unknown event types must be ignored (§5.1 forward compatibility).
        break;
      }
    }
  }

  if (!run) {
    throw new ProtocolError('missing_run', 'event stream contains no run.created');
  }

  return {
    run,
    steps,
    artifacts,
    checks,
    approvals,
    diagnosis,
    riskSummary,
    logsByStep,
    iterations,
    lastSeq,
    warnings,
  };
}
