// Typed HTTP client over the contract command API (BIBLE §5.3). A thin fetch
// wrapper: every JSON response is parsed with its contract Zod schema, and a 409
// (command invalid for the run's current state) surfaces as a typed StateConflict
// so callers refresh state instead of crashing (§5.3).
import type { z } from 'zod';
import {
  ConflictErrorSchema,
  CreateRunResponseSchema,
  GetArtifactMetaResponseSchema,
  GetBenchResponseSchema,
  GetRunEventsResponseSchema,
  HealthResponseSchema,
  ListBoardProfilesResponseSchema,
  ListRunsResponseSchema,
  SaveBoardProfileResponseSchema,
  type Artifact,
  type BenchStatus,
  type BoardProfile,
  type CreateRunRequest,
  type CreateRunResponse,
  type HealthResponse,
  type RunStatus,
  type RunSummary,
  type WireEvent,
} from '@boardex/contract';
import { RUNNER_HTTP_BASE } from './config';

// HTTP 409: the command was invalid for the run's current state (§5.3). The current
// status rides along so the UI can reconcile without a crash.
export class StateConflict extends Error {
  readonly currentStatus: RunStatus;
  constructor(message: string, currentStatus: RunStatus) {
    super(message);
    this.name = 'StateConflict';
    this.currentStatus = currentStatus;
  }
}

// Any other non-2xx (or otherwise unexpected) HTTP response.
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface JsonRequestInit {
  method?: string;
  body?: string;
}

export interface ApiClient {
  readonly baseUrl: string;
  getHealth(): Promise<HealthResponse>;
  getBench(): Promise<BenchStatus>;
  listBoardProfiles(): Promise<BoardProfile[]>;
  saveBoardProfile(profile: BoardProfile): Promise<BoardProfile>;
  listRuns(): Promise<RunSummary[]>;
  createRun(request: CreateRunRequest): Promise<CreateRunResponse>;
  approvePlan(runId: string): Promise<void>;
  resolveApproval(
    runId: string,
    approvalId: string,
    status: 'approved' | 'rejected',
  ): Promise<void>;
  stopRun(runId: string): Promise<void>;
  // WireEvent, not Event: replay is parsed envelope-first (§5.1/T5.0) so an
  // unknown-typed event in the log cannot fail the whole response.
  getRunEvents(runId: string, afterSeq?: number): Promise<WireEvent[]>;
  getArtifactMeta(artifactId: string): Promise<Artifact>;
  /** URL of an artifact's raw content (GET /artifacts/{id}); fetched by reference (§D4). */
  artifactUrl(artifactId: string): string;
  /**
   * Raw artifact content as text (GET /artifacts/{id}). No schema here: content is
   * typed by artifact.mimeType (§5.3); structured kinds are parsed by their reader.
   */
  getArtifactText(artifactId: string): Promise<string>;
  /**
   * Raw artifact content as a Blob typed by the artifact's own mimeType (§4 meta
   * is the MIME authority) — the download path for the Raw artifacts tab, binary-
   * safe for logic captures.
   */
  getArtifactBlob(artifactId: string, mimeType: string): Promise<Blob>;
}

export function createApiClient(baseUrl: string = RUNNER_HTTP_BASE): ApiClient {
  const base = baseUrl.replace(/\/+$/, '');

  async function requestJson<T>(
    path: string,
    // Input typed unknown, not T: transform schemas (GetRunEventsResponseSchema's
    // envelope-first parse) have output ≠ input, and raw JSON is unknown anyway.
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    init?: JsonRequestInit,
  ): Promise<T> {
    const res = await fetch(base + path, {
      method: init?.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });
    if (!res.ok) {
      throw new ApiError(`${init?.method ?? 'GET'} ${path} failed with ${res.status}`, res.status);
    }
    return schema.parse(await res.json());
  }

  // POST commands answer 204 on success, or 409 { error, currentStatus } (§5.3).
  async function command(path: string, body?: unknown): Promise<void> {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (res.status === 204) return;
    if (res.status === 409) {
      const parsed = ConflictErrorSchema.safeParse(await res.json().catch(() => null));
      if (parsed.success) throw new StateConflict(parsed.data.error, parsed.data.currentStatus);
      throw new ApiError(`POST ${path} returned a malformed 409`, 409);
    }
    throw new ApiError(`POST ${path} failed with ${res.status}`, res.status);
  }

  return {
    baseUrl: base,
    getHealth: () => requestJson('/health', HealthResponseSchema),
    getBench: () => requestJson('/bench', GetBenchResponseSchema),
    listBoardProfiles: () => requestJson('/board-profiles', ListBoardProfilesResponseSchema),
    saveBoardProfile: (profile) =>
      requestJson('/board-profiles', SaveBoardProfileResponseSchema, {
        method: 'POST',
        body: JSON.stringify(profile),
      }),
    listRuns: () => requestJson('/runs', ListRunsResponseSchema),
    createRun: (request) =>
      requestJson('/runs', CreateRunResponseSchema, {
        method: 'POST',
        body: JSON.stringify(request),
      }),
    approvePlan: (runId) => command(`/runs/${runId}/plan/approve`),
    resolveApproval: (runId, approvalId, status) =>
      command(`/runs/${runId}/approvals/${approvalId}`, { status }),
    stopRun: (runId) => command(`/runs/${runId}/stop`),
    getRunEvents: (runId, afterSeq = 0) =>
      requestJson(`/runs/${runId}/events?afterSeq=${afterSeq}`, GetRunEventsResponseSchema),
    getArtifactMeta: (artifactId) =>
      requestJson(`/artifacts/${artifactId}/meta`, GetArtifactMetaResponseSchema),
    artifactUrl: (artifactId) => `${base}/artifacts/${artifactId}`,
    getArtifactText: async (artifactId) => {
      const res = await fetch(`${base}/artifacts/${artifactId}`);
      if (!res.ok) {
        throw new ApiError(`GET /artifacts/${artifactId} failed with ${res.status}`, res.status);
      }
      return res.text();
    },
    getArtifactBlob: async (artifactId, mimeType) => {
      const res = await fetch(`${base}/artifacts/${artifactId}`);
      if (!res.ok) {
        throw new ApiError(`GET /artifacts/${artifactId} failed with ${res.status}`, res.status);
      }
      return new Blob([await res.arrayBuffer()], { type: mimeType });
    },
  };
}

// App-wide singleton pointed at the configured runner.
export const api = createApiClient();
