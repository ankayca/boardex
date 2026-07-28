// The Quick Start path probe, client side (POST /workspace/validate).
//
// This route is NOT in packages/contract — it is mock-prototyped and stands as a §10.5
// proposal to the backend owner (docs/decisions.md, 2026-07-28). So it lives here
// rather than in lib/api (the typed client over the CONTRACT command API), and it is
// FEATURE-DETECTED exactly like the model picker (§7.2/T6.3): a runner that does not
// implement it answers 404, the field simply stops live-validating, and Quick Start
// still completes on defaults. An absent capability is a missing feature, never an
// assumed one.
import { z } from 'zod';
import { getRunnerHttpBase } from './config';

export const WorkspaceValidationSchema = z.object({
  /** The path is DIRECTLY usable as a firmware repo root. */
  ok: z.boolean(),
  /** What the runner's stat() says about the path itself. */
  exists: z.boolean(),
  kind: z.enum(['firmware', 'directory', 'missing']),
  /** The one subdirectory holding a build file, when the given path holds none. */
  suggestedPath: z.string().optional(),
  detectedBuild: z.string().optional(),
});

export type WorkspaceValidation = z.infer<typeof WorkspaceValidationSchema>;

/**
 * `unsupported` is the feature-detection answer — the runner has no such route. It is
 * NOT an error state and renders nothing: the user's path may be perfectly good, we
 * just cannot check it from here.
 */
export type WorkspaceProbe =
  | { status: 'validated'; result: WorkspaceValidation }
  | { status: 'unsupported' };

// A runner that does not implement the route answers 404 (or 405 on a router that
// knows /workspace but not this verb). Anything else — a network failure, a 500, a
// malformed body — is a genuine failure and throws, so the caller can stay silent
// without recording "unsupported" against a runner that merely blipped.
const UNSUPPORTED_STATUSES = new Set([404, 405, 501]);

async function validate(path: string): Promise<WorkspaceProbe> {
  const base = getRunnerHttpBase().replace(/\/+$/, '');
  const res = await fetch(`${base}/workspace/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (UNSUPPORTED_STATUSES.has(res.status)) return { status: 'unsupported' };
  if (!res.ok) throw new Error(`POST /workspace/validate failed with ${res.status}`);
  return { status: 'validated', result: WorkspaceValidationSchema.parse(await res.json()) };
}

/** An object, not a bare export, so tests can spy on the one seam (mirrors lib/api). */
export const workspaceApi = { validate };
