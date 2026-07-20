// Event envelope (BIBLE §5.1) and the complete MVP event catalog (BIBLE §5.2).
// Payload schemas reference the entity schemas — never redefine entity shapes here.
import { z } from 'zod';
import {
  ApprovalSchema,
  ArtifactSchema,
  BenchStatusSchema,
  DiagnosisSchema,
  IdSchema,
  IsoDateTimeSchema,
  MeasurementCheckSchema,
  PlanStepSchema,
  RunSchema,
  RunStatusSchema,
  RunStepSchema,
} from './entities';

// §5.1 envelope fields, shared by every event. seq is monotonic per run, starts
// at 1, no gaps — gaplessness is enforced by the reducer, not the schema.
const envelopeFields = {
  seq: z.number().int().min(1),
  runId: IdSchema,
  ts: IsoDateTimeSchema,
} as const;

// Forward-compatibility envelope: the UI must ignore unknown event types (§5.1),
// so it first parses against this loose shape, then against the strict union.
export const EventEnvelopeSchema = z.object({
  ...envelopeFields,
  type: z.string(),
  payload: z.record(z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

const event = <Type extends string, Payload extends z.ZodTypeAny>(type: Type, payload: Payload) =>
  z.object({ ...envelopeFields, type: z.literal(type), payload });

export const RunCreatedEventSchema = event('run.created', z.object({ run: RunSchema }));

/**
 * v2.4 (Sprint 7 P0, additive per §10.5): the plan's declared check registry —
 * what the run INTENDS to verify, registered at plan time (the runner's
 * declare_plan already captures this list; here it reaches the wire). Optional:
 * a v2.0 producer that omits it still conforms, and recordings that predate it
 * (records/bmp180-run) reduce unchanged. Validation coverage = recorded
 * check.evaluated results measured against this registry — the denominator is
 * declared up front, never parsed from plan prose or report markdown.
 */
export const CheckExpectationSchema = z.object({
  requirementId: z.string(),
  description: z.string(),
});
export type CheckExpectation = z.infer<typeof CheckExpectationSchema>;

export const RunPlanGeneratedEventSchema = event(
  'run.plan_generated',
  z.object({
    plan: z.array(PlanStepSchema),
    riskSummary: z.string(),
    checks: z.array(CheckExpectationSchema).optional(),
  }),
);

export const RunStatusChangedEventSchema = event(
  'run.status_changed',
  z.object({ status: RunStatusSchema, reason: z.string().optional() }),
);

export const StepStartedEventSchema = event('step.started', z.object({ step: RunStepSchema }));

export const StepLogStreamSchema = z.enum(['build', 'flash', 'serial', 'rtt', 'agent']);
export type StepLogStream = z.infer<typeof StepLogStreamSchema>;

// One log line; batching allowed via `lines: string[]` (§5.2).
export const StepLogPayloadSchema = z.union([
  z.object({ stepId: IdSchema, stream: StepLogStreamSchema, line: z.string() }),
  z.object({ stepId: IdSchema, stream: StepLogStreamSchema, lines: z.array(z.string()) }),
]);
export const StepLogEventSchema = event('step.log', StepLogPayloadSchema);

const stepOutcomePayload = z.object({
  stepId: IdSchema,
  summary: z.string(),
  artifactIds: z.array(IdSchema),
});
export const StepCompletedEventSchema = event('step.completed', stepOutcomePayload);
export const StepFailedEventSchema = event('step.failed', stepOutcomePayload);

export const ArtifactCreatedEventSchema = event(
  'artifact.created',
  z.object({ artifact: ArtifactSchema }),
);

export const CheckEvaluatedEventSchema = event(
  'check.evaluated',
  z.object({ check: MeasurementCheckSchema }),
);

export const DiagnosisCreatedEventSchema = event(
  'diagnosis.created',
  z.object({ diagnosis: DiagnosisSchema }),
);

export const ApprovalRequestedEventSchema = event(
  'approval.requested',
  z.object({ approval: ApprovalSchema }),
);

export const ApprovalResolvedEventSchema = event(
  'approval.resolved',
  z.object({
    approvalId: IdSchema,
    status: z.enum(['approved', 'rejected']),
    resolvedAt: IsoDateTimeSchema,
  }),
);

// Fix loop begins a new iteration; emitted for iteration >= 2 only — iteration 1
// is implicit (§5.2, BIBLE v1.2).
export const RunIterationStartedEventSchema = event(
  'run.iteration_started',
  z.object({ iteration: z.number().int().min(2), reason: z.string() }),
);

export const RunCompletedEventSchema = event(
  'run.completed',
  z.object({ summary: z.string(), reportArtifactId: IdSchema }),
);

export const RunFailedEventSchema = event('run.failed', z.object({ summary: z.string() }));

export const RunStoppedEventSchema = event('run.stopped', z.object({ byUser: z.literal(true) }));

// Emitted on connect + on device change; runId is "_global" (§5.2).
export const RunnerStatusEventSchema = event(
  'runner.status',
  z.object({ bench: BenchStatusSchema }),
);

const eventSchemas = [
  RunCreatedEventSchema,
  RunPlanGeneratedEventSchema,
  RunStatusChangedEventSchema,
  StepStartedEventSchema,
  StepLogEventSchema,
  StepCompletedEventSchema,
  StepFailedEventSchema,
  ArtifactCreatedEventSchema,
  CheckEvaluatedEventSchema,
  DiagnosisCreatedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  RunIterationStartedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunStoppedEventSchema,
  RunnerStatusEventSchema,
] as const;

export const EventSchema = z.discriminatedUnion('type', [...eventSchemas]);
export type Event = z.infer<typeof EventSchema>;
export type EventType = Event['type'];

/** Every type in the §5.2 catalog — the boundary of "known" for wire parsing. */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(
  eventSchemas.map((schema) => schema.shape.type.value),
);

// ---------------------------------------------------------------------------
// Envelope-first wire parsing (§5.1, T5.0 / audit F1).
//
// "Unknown event types must be ignored by the UI" — but seq is gapless, so a
// dropped frame is indistinguishable from a lost one: it parks the reducer on a
// permanent gap and turns every reconnect replay into the same failure (a
// reconnect loop). Ignoring an event therefore CANNOT mean dropping it. Wire
// parsing is envelope-first: any well-formed envelope is kept so its seq counts
// toward continuity; only envelopes that also pass the strict catalog parse
// carry state. The rest — unknown types, and equally a known type whose payload
// does not conform — are tagged IgnoredEvent and contribute nothing but their
// seq. The tag is a parse-time marker, never a wire field (both the envelope
// and the catalog schemas strip unknown keys, so no wire object can smuggle it).
// ---------------------------------------------------------------------------

export interface IgnoredEvent extends EventEnvelope {
  ignored: true;
}

/** What the wire actually yields: a catalog event, or an envelope kept for seq. */
export type WireEvent = Event | IgnoredEvent;

/** Narrow a WireEvent to the strict catalog union. */
export function isKnownEvent(wire: WireEvent): wire is Event {
  return !('ignored' in wire);
}

/**
 * Parse one wire value envelope-first. Returns null only for frames that are not
 * well-formed envelopes at all (no seq to account for); everything else is either
 * a catalog Event or an IgnoredEvent that still counts toward seq continuity.
 */
export function parseWireEvent(value: unknown): WireEvent | null {
  const envelope = EventEnvelopeSchema.safeParse(value);
  if (!envelope.success) return null;
  const known = EventSchema.safeParse(value);
  return known.success ? known.data : { ...envelope.data, ignored: true };
}

/** Zod form of parseWireEvent, for response schemas (GET /runs/{id}/events). */
export const WireEventSchema = z.unknown().transform((value, ctx): WireEvent => {
  const wire = parseWireEvent(value);
  if (wire === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a well-formed event envelope' });
    return z.NEVER;
  }
  return wire;
});

export type RunCreatedEvent = z.infer<typeof RunCreatedEventSchema>;
export type RunPlanGeneratedEvent = z.infer<typeof RunPlanGeneratedEventSchema>;
export type RunStatusChangedEvent = z.infer<typeof RunStatusChangedEventSchema>;
export type StepStartedEvent = z.infer<typeof StepStartedEventSchema>;
export type StepLogEvent = z.infer<typeof StepLogEventSchema>;
export type StepCompletedEvent = z.infer<typeof StepCompletedEventSchema>;
export type StepFailedEvent = z.infer<typeof StepFailedEventSchema>;
export type ArtifactCreatedEvent = z.infer<typeof ArtifactCreatedEventSchema>;
export type CheckEvaluatedEvent = z.infer<typeof CheckEvaluatedEventSchema>;
export type DiagnosisCreatedEvent = z.infer<typeof DiagnosisCreatedEventSchema>;
export type ApprovalRequestedEvent = z.infer<typeof ApprovalRequestedEventSchema>;
export type ApprovalResolvedEvent = z.infer<typeof ApprovalResolvedEventSchema>;
export type RunIterationStartedEvent = z.infer<typeof RunIterationStartedEventSchema>;
export type RunCompletedEvent = z.infer<typeof RunCompletedEventSchema>;
export type RunFailedEvent = z.infer<typeof RunFailedEventSchema>;
export type RunStoppedEvent = z.infer<typeof RunStoppedEventSchema>;
export type RunnerStatusEvent = z.infer<typeof RunnerStatusEventSchema>;
