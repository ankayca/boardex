// Emits JSON Schema (draft-07) for the event stream and command API into
// packages/contract/json-schema/. This output is the only cross-language bridge:
// the Python runner team validates against these files (BIBLE §3, T0.2).
// Run with: npm run build:json-schema -w @boardex/contract
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ApprovalSchema,
  ArtifactSchema,
  BenchStatusSchema,
  BoardDocumentSchema,
  BoardProfileSchema,
  DiagnosisSchema,
  DocumentKindSchema,
  IdSchema,
  IsoDateTimeSchema,
  MeasurementCheckSchema,
  PlanStepSchema,
  RiskLevelSchema,
  RunSchema,
  RunStatusSchema,
  RunStepSchema,
  StepKindSchema,
  StepStatusSchema,
} from '../src/entities';
import {
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  ArtifactCreatedEventSchema,
  CheckEvaluatedEventSchema,
  DiagnosisCreatedEventSchema,
  EventSchema,
  RunCompletedEventSchema,
  RunCreatedEventSchema,
  RunFailedEventSchema,
  RunIterationStartedEventSchema,
  RunPlanGeneratedEventSchema,
  RunStatusChangedEventSchema,
  RunStoppedEventSchema,
  RunnerStatusEventSchema,
  StepCompletedEventSchema,
  StepFailedEventSchema,
  StepLogEventSchema,
  StepStartedEventSchema,
} from '../src/events';
import {
  BusStateSchema,
  CodeDiffContentSchema,
  DecodeAnnotationSchema,
  DiffFileSchema,
  I2cTransactionSchema,
  ProtocolDecodeContentSchema,
  TimingMeasurementContentSchema,
} from '../src/artifacts';
import {
  ApprovePlanRequestSchema,
  ConflictErrorSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  GetArtifactMetaResponseSchema,
  GetBenchResponseSchema,
  GetDocumentMetaResponseSchema,
  GetRunEventsQuerySchema,
  HealthResponseSchema,
  ListBoardProfilesResponseSchema,
  ListRunsResponseSchema,
  ResolveApprovalRequestSchema,
  RunSummarySchema,
  SaveBoardProfileRequestSchema,
  SaveBoardProfileResponseSchema,
  StopRunRequestSchema,
} from '../src/commands';
import { CONTRACT_VERSION } from '../src/index';

const entityDefinitions = {
  Id: IdSchema,
  IsoDateTime: IsoDateTimeSchema,
  RunStatus: RunStatusSchema,
  RiskLevel: RiskLevelSchema,
  StepKind: StepKindSchema,
  StepStatus: StepStatusSchema,
  PlanStep: PlanStepSchema,
  Run: RunSchema,
  RunStep: RunStepSchema,
  Artifact: ArtifactSchema,
  MeasurementCheck: MeasurementCheckSchema,
  Approval: ApprovalSchema,
  Diagnosis: DiagnosisSchema,
  DocumentKind: DocumentKindSchema,
  BoardDocument: BoardDocumentSchema,
  BoardProfile: BoardProfileSchema,
  BenchStatus: BenchStatusSchema,
};

const eventDefinitions = {
  ...entityDefinitions,
  Event: EventSchema,
  RunCreatedEvent: RunCreatedEventSchema,
  RunPlanGeneratedEvent: RunPlanGeneratedEventSchema,
  RunStatusChangedEvent: RunStatusChangedEventSchema,
  StepStartedEvent: StepStartedEventSchema,
  StepLogEvent: StepLogEventSchema,
  StepCompletedEvent: StepCompletedEventSchema,
  StepFailedEvent: StepFailedEventSchema,
  ArtifactCreatedEvent: ArtifactCreatedEventSchema,
  CheckEvaluatedEvent: CheckEvaluatedEventSchema,
  DiagnosisCreatedEvent: DiagnosisCreatedEventSchema,
  ApprovalRequestedEvent: ApprovalRequestedEventSchema,
  ApprovalResolvedEvent: ApprovalResolvedEventSchema,
  RunIterationStartedEvent: RunIterationStartedEventSchema,
  RunCompletedEvent: RunCompletedEventSchema,
  RunFailedEvent: RunFailedEventSchema,
  RunStoppedEvent: RunStoppedEventSchema,
  RunnerStatusEvent: RunnerStatusEventSchema,
};

// Keyed by route (§5.3); 204 routes list only a request schema, GET /artifacts/{id}
// returns raw content and is omitted.
const commandDefinitions = {
  ...entityDefinitions,
  Event: EventSchema,
  HealthResponse: HealthResponseSchema,
  GetBenchResponse: GetBenchResponseSchema,
  ListBoardProfilesResponse: ListBoardProfilesResponseSchema,
  SaveBoardProfileRequest: SaveBoardProfileRequestSchema,
  SaveBoardProfileResponse: SaveBoardProfileResponseSchema,
  RunSummary: RunSummarySchema,
  ListRunsResponse: ListRunsResponseSchema,
  CreateRunRequest: CreateRunRequestSchema,
  CreateRunResponse: CreateRunResponseSchema,
  ApprovePlanRequest: ApprovePlanRequestSchema,
  ResolveApprovalRequest: ResolveApprovalRequestSchema,
  StopRunRequest: StopRunRequestSchema,
  GetRunEventsQuery: GetRunEventsQuerySchema,
  // The producer's contract: the replay log holds catalog events only. (The TS
  // GetRunEventsResponseSchema is the READER — envelope-first per §5.1/T5.0 — and
  // deliberately looser; a transform cannot round-trip to JSON Schema anyway.)
  GetRunEventsResponse: z.array(EventSchema),
  GetArtifactMetaResponse: GetArtifactMetaResponseSchema,
  GetDocumentMetaResponse: GetDocumentMetaResponseSchema,
  ConflictError: ConflictErrorSchema,
};

// zod-to-json-schema wants a root schema; we only want the definitions map, so
// emit against a placeholder root and keep the resolved definitions.
function buildDefinitions(definitions: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const emitted = zodToJsonSchema(z.object({}), { definitions }) as {
    definitions?: Record<string, unknown>;
  };
  return emitted.definitions ?? {};
}

const DRAFT = 'http://json-schema.org/draft-07/schema#';

const eventsDocument = {
  $schema: DRAFT,
  title: 'Boardex event stream',
  description:
    `Event envelope and complete MVP event catalog for ${CONTRACT_VERSION} (BIBLE §5.1-5.2). ` +
    'Validate a single event against #/definitions/Event. seq is monotonic per run, ' +
    'starts at 1, no gaps; events are immutable and append-only.',
  $ref: '#/definitions/Event',
  definitions: buildDefinitions(eventDefinitions),
};

const commandsDocument = {
  $schema: DRAFT,
  title: 'Boardex command API',
  description:
    `Request/response schemas for the ${CONTRACT_VERSION} HTTP command API (BIBLE §5.3). ` +
    'Routes: GET /health -> HealthResponse; GET /bench -> GetBenchResponse; ' +
    'GET /board-profiles -> ListBoardProfilesResponse; POST /board-profiles: SaveBoardProfileRequest -> SaveBoardProfileResponse; ' +
    'GET /runs -> ListRunsResponse; POST /runs: CreateRunRequest -> CreateRunResponse; ' +
    'POST /runs/{id}/plan/approve: ApprovePlanRequest -> 204; ' +
    'POST /runs/{id}/approvals/{aid}: ResolveApprovalRequest -> 204; ' +
    'POST /runs/{id}/stop: StopRunRequest -> 204; ' +
    'GET /runs/{id}/events?afterSeq=N (GetRunEventsQuery) -> GetRunEventsResponse; ' +
    'GET /artifacts/{id} -> raw content per artifact.mimeType; ' +
    'GET /artifacts/{id}/meta -> GetArtifactMetaResponse; ' +
    'GET /documents/{id} -> raw content per BoardDocument.mimeType (v2.1); ' +
    'GET /documents/{id}/meta -> GetDocumentMetaResponse (v2.1). ' +
    'Invalid-for-state commands answer HTTP 409 with ConflictError.',
  definitions: buildDefinitions(commandDefinitions),
};

// Structured artifact content (BIBLE §4, promoted in T5.0): what a decode/diff/
// timing artifact's GET /artifacts/{id} body must look like. The decode shape is
// the boardex-logic pipeline's own output (parse.py annotations folded by
// decode/i2c.py), so the runner can serve adapter output verbatim.
const artifactsDocument = {
  $schema: DRAFT,
  title: 'Boardex structured artifact contents',
  description:
    `Structured JSON bodies for ${CONTRACT_VERSION} artifacts fetched by reference (BIBLE §4/§5.3): ` +
    'kind protocol_decode -> ProtocolDecodeContent; kind code_diff -> CodeDiffContent; ' +
    'kind timing_measurement -> TimingMeasurementContent. Log kinds are text/plain and ' +
    'report_md is Markdown; neither has a JSON schema.',
  definitions: buildDefinitions({
    DecodeAnnotation: DecodeAnnotationSchema,
    I2cTransaction: I2cTransactionSchema,
    BusState: BusStateSchema,
    ProtocolDecodeContent: ProtocolDecodeContentSchema,
    DiffFile: DiffFileSchema,
    CodeDiffContent: CodeDiffContentSchema,
    TimingMeasurementContent: TimingMeasurementContentSchema,
  }),
};

const outDir = fileURLToPath(new URL('../json-schema/', import.meta.url));
mkdirSync(outDir, { recursive: true });

for (const [file, document] of [
  ['events.schema.json', eventsDocument],
  ['commands.schema.json', commandsDocument],
  ['artifacts.schema.json', artifactsDocument],
] as const) {
  writeFileSync(`${outDir}${file}`, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`wrote json-schema/${file}`);
}
