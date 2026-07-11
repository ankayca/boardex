// Code-diff parsing (BIBLE §7.4). The code_diff artifact is the contract's
// CodeDiffContent (promoted in T5.0) — { files: [{ path, reason, diff }] } —
// where each diff is a per-file unified diff string. Both layers fail closed per
// the T3.1 decode pattern: malformed JSON / wrong shape resolves to { ok: false }
// for the whole artifact, and a file whose diff text isn't a readable unified
// diff resolves to a per-file error — never a crash, never a silently empty
// rendering.
import { CodeDiffContentSchema, type CodeDiffContent, type DiffFile } from '@boardex/contract';

export type { DiffFile };
export type CodeDiff = CodeDiffContent;
export const CodeDiffSchema = CodeDiffContentSchema;

export type CodeDiffParseResult = { ok: true; diff: CodeDiff } | { ok: false; error: string };

export function parseCodeDiff(text: string): CodeDiffParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Artifact content is not valid JSON.' };
  }
  const parsed = CodeDiffSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (at ${issue.path.join('.')})` : '';
    return {
      ok: false,
      error: `Artifact JSON does not match the code-diff shape${where}.`,
    };
  }
  return { ok: true, diff: parsed.data };
}

export interface DiffLine {
  kind: 'add' | 'del' | 'context';
  text: string;
  /** 1-based line number in the old file; null for added lines. */
  oldNo: number | null;
  /** 1-based line number in the new file; null for removed lines. */
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export type UnifiedDiffResult = { ok: true; hunks: DiffHunk[] } | { ok: false; error: string };

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// A ---/+++ file-header line. Del/add code lines carry their own prefix, so a
// header is "---"/"+++" alone or followed by a space (--- a/main.c).
const FILE_HEADER_RE = /^(---|\+\+\+)( |$)/;

// Parse one file's unified diff text into hunks of typed lines with running
// old/new line numbers. The @@ header's declared line counts are tracked so the
// parse fails closed instead of mislabeling code:
// - a line whose kind would overrun the counts is malformed, not silently kept;
// - a ---/+++ header at a hunk boundary (counts exhausted) terminates that
//   file's parse and begins the next file section — it is never consumed as a
//   del/add code line — while a stray header mid-hunk fails closed;
// - a bare empty line (some emitters strip the context space) is empty context
//   when the hunk still expects lines, and only a trailing-newline artifact
//   when it is the final line of an already-complete hunk.
// Lines before the first hunk (---/+++/index headers) are tolerated and
// skipped; "\ No newline at end of file" markers are skipped; a hunk truncated
// before its declared counts are met is tolerated (nothing was mislabeled).
export function parseUnifiedDiff(text: string): UnifiedDiffResult {
  const rawLines = text.split('\n');
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  const fail = (i: number, why: string): UnifiedDiffResult => ({
    ok: false,
    error: `${why} at line ${i + 1}: "${(rawLines[i] as string).slice(0, 40)}"`,
  });

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i] as string;
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      current = { header: line, lines: [] };
      hunks.push(current);
      oldNo = Number(hunkMatch[1]);
      newNo = Number(hunkMatch[3]);
      oldLeft = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
      newLeft = hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1;
      continue;
    }
    if (!current) continue; // file header region before (or between) hunks
    const exhausted = oldLeft === 0 && newLeft === 0;
    if (FILE_HEADER_RE.test(line)) {
      if (!exhausted) return fail(i, 'File header inside a hunk');
      current = null; // this file's hunks are done; the next file's headers follow
      continue;
    }
    if (line === '' && i === rawLines.length - 1 && exhausted) continue; // trailing newline
    const prefix = line === '' ? ' ' : (line[0] as string);
    const text_ = line.slice(1);
    if (prefix === '\\') continue; // "\ No newline at end of file"
    if (prefix === '+') {
      if (newLeft === 0) return fail(i, "Added line past the hunk's declared counts");
      newLeft--;
      current.lines.push({ kind: 'add', text: text_, oldNo: null, newNo: newNo++ });
    } else if (prefix === '-') {
      if (oldLeft === 0) return fail(i, "Removed line past the hunk's declared counts");
      oldLeft--;
      current.lines.push({ kind: 'del', text: text_, oldNo: oldNo++, newNo: null });
    } else if (prefix === ' ') {
      if (oldLeft === 0 || newLeft === 0) {
        return fail(i, "Context line past the hunk's declared counts");
      }
      oldLeft--;
      newLeft--;
      current.lines.push({ kind: 'context', text: text_, oldNo: oldNo++, newNo: newNo++ });
    } else {
      return fail(i, 'Unreadable line prefix');
    }
  }

  if (hunks.length === 0) {
    return { ok: false, error: 'No unified-diff hunks (@@) found.' };
  }
  return { ok: true, hunks };
}
