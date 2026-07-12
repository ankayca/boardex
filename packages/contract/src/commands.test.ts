import { describe, expect, it } from 'vitest';
import {
  ConflictErrorSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  GetDocumentMetaResponseSchema,
  GetRunEventsQuerySchema,
  HealthResponseSchema,
  ListRunsResponseSchema,
  ResolveApprovalRequestSchema,
  SaveBoardProfileRequestSchema,
} from './commands';
import { sampleBoardDocument, sampleBoardProfile } from './test-samples';

describe('command schemas', () => {
  it('parses a health response', () => {
    const health = { ok: true, contractVersion: 'boardex-contract/0.1', runnerKind: 'mock' };
    expect(HealthResponseSchema.parse(health)).toEqual(health);
    expect(() => HealthResponseSchema.parse({ ...health, runnerKind: 'fake' })).toThrow();
  });

  // v2.1 (T6.3): capabilities is optional and feature-detected — a health response
  // without it is valid (a runner that offers no model choice), and one with it
  // round-trips the advertised models.
  it('round-trips an optional capabilities block on health', () => {
    const withCaps = {
      ok: true,
      contractVersion: 'boardex-contract/0.1',
      runnerKind: 'mock',
      capabilities: { models: ['mock-model', 'mock-model-pro'] },
    };
    expect(HealthResponseSchema.parse(withCaps)).toEqual(withCaps);
    // Absent capabilities parses too (no field injected).
    const parsed = HealthResponseSchema.parse({
      ok: true,
      contractVersion: 'boardex-contract/0.1',
      runnerKind: 'real',
    });
    expect(parsed.capabilities).toBeUndefined();
  });

  it('parses create-run request/response and rejects missing fields', () => {
    const request = { taskPrompt: 'Bring up BME280', boardProfileId: 'bp_01' };
    expect(CreateRunRequestSchema.parse(request)).toEqual(request);
    expect(() => CreateRunRequestSchema.parse({ taskPrompt: 'no profile' })).toThrow();
    expect(CreateRunResponseSchema.parse({ runId: 'run_01' })).toEqual({ runId: 'run_01' });
  });

  // v2.1 (T6.3): an optional model rides along with a create-run request.
  it('round-trips an optional model on create-run', () => {
    const request = { taskPrompt: 'Bring up BME280', boardProfileId: 'bp_01', model: 'mock-model' };
    expect(CreateRunRequestSchema.parse(request)).toEqual(request);
  });

  // v2.1 (T6.3): GET /documents/{id}/meta returns a BoardDocument descriptor.
  it('round-trips a document meta response and rejects an unknown kind', () => {
    expect(GetDocumentMetaResponseSchema.parse(sampleBoardDocument)).toEqual(sampleBoardDocument);
    expect(() =>
      GetDocumentMetaResponseSchema.parse({ ...sampleBoardDocument, kind: 'firmware' }),
    ).toThrow();
  });

  it('parses run summaries', () => {
    const summaries = [
      {
        id: 'run_01',
        title: 'BME280 bring-up',
        status: 'awaiting_approval',
        boardProfileId: 'bp_01',
        updatedAt: '2026-07-07T14:03:22.114Z',
      },
    ];
    expect(ListRunsResponseSchema.parse(summaries)).toEqual(summaries);
  });

  it('parses an approval decision and rejects pending', () => {
    expect(ResolveApprovalRequestSchema.parse({ status: 'rejected' })).toEqual({
      status: 'rejected',
    });
    expect(() => ResolveApprovalRequestSchema.parse({ status: 'pending' })).toThrow();
  });

  it('round-trips a board profile', () => {
    expect(SaveBoardProfileRequestSchema.parse(sampleBoardProfile)).toEqual(sampleBoardProfile);
  });

  it('coerces the afterSeq query parameter', () => {
    expect(GetRunEventsQuerySchema.parse({ afterSeq: '42' })).toEqual({ afterSeq: 42 });
    expect(GetRunEventsQuerySchema.parse({})).toEqual({});
  });

  it('parses the 409 conflict error shape', () => {
    const conflict = { error: 'approval already resolved', currentStatus: 'running' };
    expect(ConflictErrorSchema.parse(conflict)).toEqual(conflict);
    expect(() => ConflictErrorSchema.parse({ error: 'nope', currentStatus: 'paused' })).toThrow();
  });
});
