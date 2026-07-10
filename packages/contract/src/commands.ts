// Command API request/response schemas — BIBLE §5.3, one pair per route.
// Routes answering 204 have no response schema. GET /artifacts/{id} returns raw
// content typed by artifact.mimeType, so it has no JSON schema either.
import { z } from 'zod';
import {
  ArtifactSchema,
  BenchStatusSchema,
  BoardProfileSchema,
  IdSchema,
  IsoDateTimeSchema,
  RunStatusSchema,
} from './entities';
import { WireEventSchema } from './events';

// GET /health
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  contractVersion: z.string(),
  runnerKind: z.enum(['mock', 'real']),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// GET /bench
export const GetBenchResponseSchema = BenchStatusSchema;

// GET /board-profiles
export const ListBoardProfilesResponseSchema = z.array(BoardProfileSchema);

// POST /board-profiles — create/update a BoardProfile; echoes the stored profile.
export const SaveBoardProfileRequestSchema = BoardProfileSchema;
export const SaveBoardProfileResponseSchema = BoardProfileSchema;

// GET /runs
export const RunSummarySchema = z.object({
  id: IdSchema,
  title: z.string(),
  status: RunStatusSchema,
  boardProfileId: IdSchema,
  updatedAt: IsoDateTimeSchema,
});
export type RunSummary = z.infer<typeof RunSummarySchema>;
export const ListRunsResponseSchema = z.array(RunSummarySchema);

// POST /runs
export const CreateRunRequestSchema = z.object({
  taskPrompt: z.string(),
  boardProfileId: IdSchema,
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export const CreateRunResponseSchema = z.object({ runId: IdSchema });
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

// POST /runs/{id}/plan/approve — empty body -> 204
export const ApprovePlanRequestSchema = z.object({});

// POST /runs/{id}/approvals/{aid} — -> 204
export const ResolveApprovalRequestSchema = z.object({
  status: z.enum(['approved', 'rejected']),
});
export type ResolveApprovalRequest = z.infer<typeof ResolveApprovalRequestSchema>;

// POST /runs/{id}/stop — empty body -> 204
export const StopRunRequestSchema = z.object({});

// GET /runs/{id}/events?afterSeq=N — HTTP replay for reconnect/history.
// afterSeq arrives as a query string; coerced to a number.
export const GetRunEventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
});
export type GetRunEventsQuery = z.infer<typeof GetRunEventsQuerySchema>;
// Envelope-first, per event (§5.1, T5.0/F1): the replay path must tolerate exactly
// what the live socket tolerates, or an unknown-typed event in the log turns every
// reconnect into a parse failure and the reconnect into a loop. Producers still
// emit only catalog events — the emitted JSON Schema keeps this response as
// Event[]; the looseness here is the reader's side of the same rule.
export const GetRunEventsResponseSchema = z.array(WireEventSchema);

// GET /artifacts/{id}/meta
export const GetArtifactMetaResponseSchema = ArtifactSchema;

// Command errors: HTTP 409 with { error, currentStatus } when a command is
// invalid for the run's state. The UI renders 409s as state refresh, not crashes.
export const ConflictErrorSchema = z.object({
  error: z.string(),
  currentStatus: RunStatusSchema,
});
export type ConflictError = z.infer<typeof ConflictErrorSchema>;
