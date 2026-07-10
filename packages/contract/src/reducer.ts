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
import { isKnownEvent, type Event, type StepLogStream, type WireEvent } from './events';

// RunView's diagnosis carries the reducer-derived link to its fix approval: the id
// of the first approval.requested whose seq follows the diagnosis.created (§5.4
// v1.6); undefined until that approval arrives. The wire Diagnosis is unchanged.
export interface DiagnosisView extends Diagnosis {
  fixApprovalId?: string;
}

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
  diagnosis?: DiagnosisView;
  // From run.plan_generated (§5.2); undefined before the plan exists.
  riskSummary?: string;
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

export function reduceRun(events: readonly WireEvent[]): RunView {
  let run: Run | undefined;
  let diagnosis: DiagnosisView | undefined;
  let riskSummary: string | undefined;
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
        if (TERMINAL_STATUSES.has(event.payload.status) && !endedAtFromTerminalEvent) {
          endedAt = event.ts;
        }
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
        upsertById(approvals, event.payload.approval);
        // §5.4 v1.6: the first approval requested after diagnosis.created is that
        // diagnosis's fix approval; earlier approvals can never claim it because
        // events reduce in seq order and the diagnosis does not exist yet.
        if (diagnosis && diagnosis.fixApprovalId === undefined) {
          diagnosis = { ...diagnosis, fixApprovalId: event.payload.approval.id };
        }
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
        endedAt = event.ts;
        endedAtFromTerminalEvent = true;
        break;
      }
      case 'run.failed': {
        run = { ...requireRun(event), status: 'failed' };
        endedAt = event.ts;
        endedAtFromTerminalEvent = true;
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
    endedAt,
    logsByStep,
    iterations,
    lastSeq,
    warnings,
  };
}
