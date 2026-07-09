// Code-diff parsing (BIBLE §7.4). The code_diff artifact is structured JSON —
// { files: [{ path, reason, diff }] } — where each diff is a per-file unified
// diff string. Both layers fail closed per the T3.1 decode pattern: malformed
// JSON / wrong shape resolves to { ok: false } for the whole artifact, and a
// file whose diff text isn't a readable unified diff resolves to a per-file
// error — never a crash, never a silently empty rendering.
import { z } from 'zod';

const DiffFileSchema = z.object({
  path: z.string(),
  reason: z.string(),
  diff: z.string(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

// Unknown extra wrapper fields pass through Zod's default stripping — the schema
// is a reader of the fields the tab consumes, same stance as the decode reader.
export const CodeDiffSchema = z.object({
  files: z.array(DiffFileSchema),
});
export type CodeDiff = z.infer<typeof CodeDiffSchema>;

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

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Parse one file's unified diff text into hunks of typed lines with running
// old/new line numbers. Strict where it matters: text with no hunk headers, or a
// line inside a hunk with an unknown prefix, is malformed — fail closed rather
// than mislabel code. Lines before the first hunk (---/+++/index headers) are
// tolerated and skipped; "\ No newline at end of file" markers are skipped; a
// bare empty line inside a hunk is read as empty context (some emitters strip
// the trailing space).
export function parseUnifiedDiff(text: string): UnifiedDiffResult {
  const rawLines = text.split('\n');
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i] as string;
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      current = { header: line, lines: [] };
      hunks.push(current);
      oldNo = Number(hunkMatch[1]);
      newNo = Number(hunkMatch[2]);
      continue;
    }
    if (!current) continue; // file header region before the first hunk
    if (line === '' && i === rawLines.length - 1) continue; // trailing newline
    const prefix = line === '' ? ' ' : (line[0] as string);
    const text_ = line.slice(1);
    if (prefix === '\\') continue;
    if (prefix === '+') {
      current.lines.push({ kind: 'add', text: text_, oldNo: null, newNo: newNo++ });
    } else if (prefix === '-') {
      current.lines.push({ kind: 'del', text: text_, oldNo: oldNo++, newNo: null });
    } else if (prefix === ' ') {
      current.lines.push({ kind: 'context', text: text_, oldNo: oldNo++, newNo: newNo++ });
    } else {
      return { ok: false, error: `Unreadable diff line ${i + 1}: "${line.slice(0, 40)}"` };
    }
  }

  if (hunks.length === 0) {
    return { ok: false, error: 'No unified-diff hunks (@@) found.' };
  }
  return { ok: true, hunks };
}
