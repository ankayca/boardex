// Entity schemas — BIBLE §4, exact field names and enums. The bible is the
// authority; these schemas must match §4 and never grow fields it doesn't define.
import { z } from 'zod';

// Identifiers are string ULIDs; the ULID format is intentionally NOT enforced (§4).
export const IdSchema = z.string().describe('String ULID identifier (format not enforced)');

// Timestamps are ISO 8601 strings (§4 Run.createdAt/updatedAt, §5.1 envelope ts).
// §4 says "ISO 8601", not "ISO 8601 with zone": naive (zoneless) timestamps are
// accepted on the wire alongside offset and Z forms (T5.0). Producers SHOULD emit
// UTC with Z; the schema is the reader and reads what §4 actually promises.
export const IsoDateTimeSchema = z
  .string()
  .datetime({ offset: true, local: true })
  .describe('ISO 8601 timestamp (offset, Z, or naive/local)');

export const RunStatusSchema = z.enum([
  'draft',
  'planning',
  'plan_ready',
  'running',
  'awaiting_approval',
  'diagnosing',
  'completed',
  'failed',
  'stopped',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const StepKindSchema = z.enum([
  'understand_context',
  'edit_code',
  'build',
  'flash',
  'capture',
  'read_serial',
  'evaluate',
  'diagnose',
  'report',
]);
export type StepKind = z.infer<typeof StepKindSchema>;

export const StepStatusSchema = z.enum(['pending', 'active', 'succeeded', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const PlanStepSchema = z.object({
  index: z.number().int(),
  title: z.string(),
  detail: z.string(),
  riskLevel: RiskLevelSchema,
  hardwareAction: z.boolean(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const RunSchema = z.object({
  id: IdSchema,
  title: z.string(),
  taskPrompt: z.string(),
  boardProfileId: IdSchema,
  status: RunStatusSchema,
  plan: z.array(PlanStepSchema).optional(), // plain-language, 5-8 steps
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  iteration: z.number().int().min(1), // fix-loop counter, starts at 1
  // v2.1 (T6.3): the runner model this run used, echoed from CreateRun.model.
  // Optional and feature-detected — a runner advertising no capabilities omits it.
  model: z.string().optional(),
});
export type Run = z.infer<typeof RunSchema>;

export const RunStepSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  planIndex: z.number().int(),
  kind: StepKindSchema,
  status: StepStatusSchema,
  title: z.string(),
  startedAt: IsoDateTimeSchema.optional(),
  endedAt: IsoDateTimeSchema.optional(),
  summary: z.string().optional(), // agent's short explanation
  artifactIds: z.array(IdSchema),
});
export type RunStep = z.infer<typeof RunStepSchema>;

export const ArtifactKindSchema = z.enum([
  'serial_log',
  'build_log',
  'flash_log',
  'logic_capture',
  'protocol_decode',
  'code_diff',
  'timing_measurement',
  'report_md',
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

// Content is fetched via GET /artifacts/{id}; decode/diff/timing kinds return
// structured JSON, log kinds return text/plain (§4).
export const ArtifactSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  stepId: IdSchema,
  kind: ArtifactKindSchema,
  label: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().min(0),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const CheckVerdictSchema = z.enum(['pass', 'fail', 'needs_review']);
export type CheckVerdict = z.infer<typeof CheckVerdictSchema>;

export const MeasurementCheckSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  requirementId: z.string(),
  description: z.string(), // "I2C clock must be 100 kHz ±10%"
  measurement: z.string(), // "logic_analyzer.i2c.scl_frequency"
  expected: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
    equals: z.union([z.boolean(), z.string()]).optional(),
    pattern: z.string().optional(),
  }),
  actual: z.object({
    value: z.union([z.number(), z.boolean(), z.string()]),
    unit: z.string().optional(),
  }),
  verdict: CheckVerdictSchema,
  artifactId: IdSchema, // REQUIRED — evidence linking is law
  sourceRef: z.string().optional(), // e.g. "BME280 datasheet §6.2" (free-text; fallback rendering)
  // v2.1 (T6.3): the resolvable form of the citation, beside sourceRef. documentId
  // is a BoardProfile.documents[] id; locator is an in-document pointer (a markdown
  // heading slug/anchor, or best-effort text for other kinds). sourceRef stays as
  // the fallback when a document cannot be resolved.
  sourceDoc: z
    .object({
      documentId: IdSchema,
      locator: z.string().optional(),
    })
    .optional(),
});
export type MeasurementCheck = z.infer<typeof MeasurementCheckSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  proposal: z.object({
    title: z.string(),
    reason: z.string(),
    riskLevel: RiskLevelSchema,
    filesChanged: z.array(z.string()),
    hardwareActions: z.array(z.string()),
  }),
  status: ApprovalStatusSchema,
  resolvedAt: IsoDateTimeSchema.optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const HypothesisConfidenceSchema = z.enum(['high', 'moderate', 'low']);
export type HypothesisConfidence = z.infer<typeof HypothesisConfidenceSchema>;

export const DiagnosisSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  failedCheckIds: z.array(IdSchema),
  hypotheses: z.array(
    z.object({
      cause: z.string(),
      evidence: z.string(),
      confidence: HypothesisConfidenceSchema,
    }),
  ),
  proposedFix: z.object({
    summary: z.string(),
    riskLevel: RiskLevelSchema,
    filesChanged: z.array(z.string()),
  }),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

// v2.1 (T6.3): profile-attached reference material. The runner owns the bytes and
// serves them by reference (§5.3 GET /documents/{id}); the Board Profile Builder
// edits this metadata only — content upload is the runner's, not the UI's.
export const DocumentKindSchema = z.enum(['datasheet', 'schematic', 'reference']);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

export const BoardDocumentSchema = z.object({
  id: IdSchema,
  label: z.string(),
  kind: DocumentKindSchema,
  mimeType: z.string(), // e.g. "text/markdown", "application/pdf"
});
export type BoardDocument = z.infer<typeof BoardDocumentSchema>;

export const BoardProfileSchema = z.object({
  id: IdSchema,
  name: z.string(),
  mcu: z.string(),
  repoPath: z.string(),
  buildCommand: z.string(),
  flashCommand: z.string(),
  resetCommand: z.string(),
  serial: z.object({
    port: z.string(),
    baud: z.number().int(),
  }),
  instruments: z.object({
    debugProbe: z.string(), // e.g. "ST-Link (on-board, via pyOCD)"
    logicAnalyzer: z.string().optional(), // e.g. "Kingst LA2016 (sigrok)"
  }),
  safety: z.object({
    maxIterations: z.number().int(),
    flashRequiresApproval: z.boolean(),
    powerNote: z.string(), // manual power mode text
  }),
  connectionChecklist: z.array(z.object({ label: z.string(), detail: z.string() })), // D12
  knownQuirks: z.array(z.string()),
  // v2.1 (T6.3): reference material the runner serves by id (§5.3).
  documents: z.array(BoardDocumentSchema).optional(),
});
export type BoardProfile = z.infer<typeof BoardProfileSchema>;

export const BenchDeviceKindSchema = z.enum(['debug_probe', 'serial', 'logic_analyzer']);
export type BenchDeviceKind = z.infer<typeof BenchDeviceKindSchema>;

export const BenchDeviceStateSchema = z.enum(['online', 'offline', 'error']);
export type BenchDeviceState = z.infer<typeof BenchDeviceStateSchema>;

export const BenchStatusSchema = z.object({
  runnerOnline: z.boolean(),
  contractVersion: z.string(),
  devices: z.array(
    z.object({
      // Backend registry's stable device_id, e.g. "sigrok:kingst-la2016:conn=3.12".
      id: z.string(),
      kind: BenchDeviceKindSchema,
      name: z.string(),
      state: BenchDeviceStateSchema,
      detail: z.string().optional(),
    }),
  ),
});
export type BenchStatus = z.infer<typeof BenchStatusSchema>;
