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

export const RunPlanGeneratedEventSchema = event(
  'run.plan_generated',
  z.object({ plan: z.array(PlanStepSchema), riskSummary: z.string() }),
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

export const EventSchema = z.discriminatedUnion('type', [
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
]);
export type Event = z.infer<typeof EventSchema>;
export type EventType = Event['type'];

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
