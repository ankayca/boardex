// POST /workspace/validate — the Quick Start path probe (v0).
//
// This route is MOCK-PROTOTYPED and deliberately NOT in packages/contract: it is a
// §10.5 proposal to the backend owner, not a shipped contract addition (see
// docs/decisions.md, 2026-07-28). The UI therefore feature-detects it — a runner that
// does not implement it answers 404 and Quick Start simply stops live-validating.
//
// It answers one question: is this runner-local path a firmware folder we could build
// in? Strictly READ-ONLY — stat + one directory listing, never a write, never an exec,
// and never a walk deeper than one level below the given path.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type WorkspaceKind = 'firmware' | 'directory' | 'missing';

export interface WorkspaceValidateResponse {
  /** True only when the path is DIRECTLY usable as a firmware repo root. */
  ok: boolean;
  /** What stat() says about the path itself, independent of what is in it. */
  exists: boolean;
  kind: WorkspaceKind;
  /** The one subdirectory that holds a build file, when the given path holds none. */
  suggestedPath?: string;
  /** The build command implied by the build file found — at `path`, or at `suggestedPath`. */
  detectedBuild?: string;
}

// The build files the probe recognises, in precedence order: a Makefile beside a
// CMakeLists is how a CMake project is usually driven on a bench, so make wins.
// 'cmake --build' is reported verbatim per the Quick Start spec — the probe reports
// what it detected, it does not compose a runnable invocation.
const BUILD_FILES: readonly { readonly file: string; readonly command: string }[] = [
  { file: 'Makefile', command: 'make' },
  { file: 'makefile', command: 'make' },
  { file: 'CMakeLists.txt', command: 'cmake --build' },
];

/**
 * Expand `~`, drop trailing slashes, and resolve to an absolute path. A relative path
 * resolves against the RUNNER's working directory — the same trust domain as
 * BoardProfile.repoPath itself, which the runner also interprets locally.
 */
export function expandPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  const expanded =
    trimmed === '~' || trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(1)) : trimmed;
  // resolve() also normalizes trailing slashes ("/bench/fw/" → "/bench/fw").
  return resolve(expanded);
}

/** The build command implied by `dir`'s own build file, or undefined when it has none. */
function detectBuild(dir: string): string | undefined {
  for (const candidate of BUILD_FILES) {
    const stat = statSync(join(dir, candidate.file), { throwIfNoEntry: false });
    if (stat?.isFile()) return candidate.command;
  }
  return undefined;
}

/**
 * ONE level down: the run-1 confusion is a repo root handed over while the firmware
 * lives in a subfolder. A suggestion is offered only when EXACTLY one immediate
 * subdirectory holds a build file — two candidates is a guess, and Quick Start does not
 * guess. Dot-directories are skipped (.git holds no firmware).
 */
function findSingleBuildSubdir(
  dir: string,
): { suggestedPath: string; detectedBuild: string } | undefined {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const found: { suggestedPath: string; detectedBuild: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const child = join(dir, entry.name);
    const detectedBuild = detectBuild(child);
    if (detectedBuild) found.push({ suggestedPath: child, detectedBuild });
  }
  return found.length === 1 ? found[0] : undefined;
}

const MISSING: WorkspaceValidateResponse = { ok: false, exists: false, kind: 'missing' };

/**
 * Probe one path. Four answers:
 *   firmware  — a directory with a build file: ok, plus the detected build command.
 *   directory — a directory without one, optionally with the single build-bearing
 *               subdirectory as suggestedPath.
 *   missing   — nothing at that path (exists false), or something that is not a
 *               directory (exists TRUE, but nothing to build in — the caller
 *               distinguishes "no such path" from "that is a file" via `exists`).
 * An unreadable path answers exactly as a missing one does: the runner cannot use it
 * either way, and the probe never reports more than it truthfully knows.
 */
export function validateWorkspacePath(raw: string): WorkspaceValidateResponse {
  const path = expandPath(raw);
  if (path.length === 0) return MISSING;

  let stat;
  try {
    stat = statSync(path, { throwIfNoEntry: false });
  } catch {
    return MISSING;
  }
  if (!stat) return MISSING;
  if (!stat.isDirectory()) return { ok: false, exists: true, kind: 'missing' };

  const detectedBuild = detectBuild(path);
  if (detectedBuild) return { ok: true, exists: true, kind: 'firmware', detectedBuild };

  const suggestion = findSingleBuildSubdir(path);
  return { ok: false, exists: true, kind: 'directory', ...(suggestion ?? {}) };
}
