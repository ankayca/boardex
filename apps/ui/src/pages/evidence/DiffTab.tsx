// Code Diff tab (BIBLE §7.4): the code_diff artifact's structured JSON rendered
// as per-file unified diffs — per-file reason line, hunk headers, old/new line
// numbers, restrained C syntax highlighting. Colors stay inside §6.1 with the
// D14 reservations intact (decisions.md 2026-07-09): added/removed lines do NOT
// use green/red — removals render dimmed on the neutral tint, additions render
// full-contrast, both behind +/- gutters. Rollback is visible here per §7.4:
// enabled only while the run is non-terminal, disabled with an explanatory
// tooltip otherwise; MVP surfaces the affordance only (no client-side revert,
// no contract route yet). Malformed JSON fails the tab closed; a malformed
// per-file diff fails that file closed — same pattern as the decode tab.
import { useMemo, useState } from 'react';
import type { Artifact, RunView } from '@boardex/contract';
import { Button } from '../../design';
import { ArtifactContentGate, useArtifactContent } from './ArtifactContent';
import { parseCodeDiff, parseUnifiedDiff, type DiffFile, type DiffLine } from './diff';
import { tokenizeC, type TokenKind } from './highlight';
import { ROLLBACK_MVP_NOTICE, rollbackEnabled, rollbackTooltip } from './rollback';

// Token classes expressed strictly with §6.1 tokens: accent + weight for
// keywords/preprocessor, secondary + italics for comments, secondary for strings.
const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: '',
  keyword: 'text-accent',
  preproc: 'text-accent',
  comment: 'italic text-text-secondary',
  string: 'text-text-secondary',
};

function CodeText({ text, highlight }: { text: string; highlight: boolean }) {
  if (!highlight) return <>{text}</>;
  return (
    <>
      {tokenizeC(text).map((token, i) =>
        token.kind === 'plain' ? (
          token.text
        ) : (
          <span key={i} className={TOKEN_CLASS[token.kind]}>
            {token.text}
          </span>
        ),
      )}
    </>
  );
}

const NUM_CELL = 'w-12 select-none px-2 text-right text-text-secondary';

function DiffLineRow({ line }: { line: DiffLine }) {
  const rowClass =
    line.kind === 'del' ? 'bg-neutral-badge-bg text-text-secondary' : 'text-text-primary';
  return (
    <tr data-diff={line.kind} className={rowClass}>
      <td className={NUM_CELL}>{line.oldNo ?? ''}</td>
      <td className={NUM_CELL}>{line.newNo ?? ''}</td>
      <td className="w-6 select-none px-1 text-center font-medium">
        {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}
      </td>
      <td className="whitespace-pre pr-3">
        {/* Removed code stays uniformly dimmed; highlighting it would fight the dimming. */}
        <CodeText text={line.text} highlight={line.kind !== 'del'} />
      </td>
    </tr>
  );
}

function FileDiff({ file }: { file: DiffFile }) {
  const parsed = useMemo(() => parseUnifiedDiff(file.diff), [file.diff]);
  return (
    <section aria-label={`Diff for ${file.path}`} className="mt-4 first:mt-0">
      <p className="font-mono text-body font-medium text-text-primary">{file.path}</p>
      <p className="mt-0.5 text-meta text-text-secondary">{file.reason}</p>
      {parsed.ok ? (
        <div className="mt-2 overflow-x-auto rounded-button border border-border bg-bg-panel">
          <table
            aria-label={`Unified diff for ${file.path}`}
            className="w-full border-collapse font-mono text-meta leading-5"
          >
            <tbody>
              {parsed.hunks.map((hunk, hunkIndex) => (
                <FileHunk key={hunkIndex} header={hunk.header} lines={hunk.lines} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div role="alert" className="mt-2 rounded-card border border-warn bg-warn-bg px-4 py-3">
          <p className="text-body font-medium text-warn">Diff unreadable</p>
          <p className="mt-1 text-meta text-text-secondary">
            {file.path}: {parsed.error}
          </p>
        </div>
      )}
    </section>
  );
}

function FileHunk({ header, lines }: { header: string; lines: DiffLine[] }) {
  return (
    <>
      <tr className="bg-neutral-badge-bg text-text-secondary">
        <td colSpan={4} className="px-2 py-0.5">
          {header}
        </td>
      </tr>
      {lines.map((line, index) => (
        <DiffLineRow key={index} line={line} />
      ))}
    </>
  );
}

export interface DiffTabProps {
  view: RunView;
  /** The code_diff artifact a deep link targeted; falls back to the run's latest. */
  artifact: Artifact | null;
}

export function DiffTab({ view, artifact }: DiffTabProps) {
  const [rollbackNotice, setRollbackNotice] = useState(false);
  const content = useArtifactContent(artifact?.id);

  const parsed = useMemo(
    () => (content.data !== undefined ? parseCodeDiff(content.data) : null),
    [content.data],
  );

  if (!artifact) {
    return (
      <p role="status" className="text-body text-text-secondary">
        No code changes have been proposed for this run yet.
      </p>
    );
  }

  const enabled = rollbackEnabled(view.run.status);

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <p className="text-meta text-text-secondary">{artifact.label}</p>
        <Button
          variant="secondary"
          disabled={!enabled}
          title={rollbackTooltip(view.run.status)}
          onClick={() => setRollbackNotice(true)}
        >
          Rollback
        </Button>
      </div>
      {rollbackNotice && (
        <p
          role="status"
          className="mt-2 rounded-card border border-border bg-bg-app px-4 py-2 text-meta text-text-secondary"
        >
          {ROLLBACK_MVP_NOTICE}
        </p>
      )}

      <div className="mt-3">
        <ArtifactContentGate artifact={artifact} noun="diff" content={content} parsed={parsed}>
          {parsed?.ok &&
            (parsed.diff.files.length === 0 ? (
              <p role="status" className="text-body text-text-secondary">
                The diff artifact contains no file changes.
              </p>
            ) : (
              parsed.diff.files.map((file) => <FileDiff key={file.path} file={file} />)
            ))}
        </ArtifactContentGate>
      </div>
    </div>
  );
}
