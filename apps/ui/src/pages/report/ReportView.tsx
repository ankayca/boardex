// Renders the parsed Validation Report (BIBLE §7.6) with house typography — this is
// a RENDER of the runner-authored Markdown, never a regeneration: the artifact text
// is the truth, this only adds presentation (§6.1 tokens). Internal references are
// resolved by the evidence-linking law's currency: a text or bold run whose exact
// content matches an artifact label present in RunView.artifacts becomes an evidence
// deep link; anything unresolvable stays plain text — fail-closed, never a dead href.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Artifact } from '@boardex/contract';
import { evidenceHref } from '../workspace/evidence';
import { parseMarkdown, type Block, type Inline, type TableAlign } from './markdown';

export interface ReportViewProps {
  markdown: string;
  runId: string;
  /** RunView.artifacts — the authority for which label references resolve (§4). */
  artifacts: readonly Artifact[];
}

const LINK_CLASS = 'text-accent underline underline-offset-2 hover:text-accent-hover';
const CODE_CLASS = 'rounded bg-neutral-badge-bg px-1 py-0.5 font-mono text-meta text-text-primary';

// The report_md is fetched runner (later: model) output — its link hrefs are as
// untrusted as any user input. Only http(s) URLs and app-internal absolute paths
// (the evidence deep links) render as anchors; every other scheme — javascript:,
// data:, vbscript:, protocol-relative //host — degrades to the link text as plain
// text. Fail-closed: no live script-scheme anchor, and no dead anchor either.
type LinkSafety = 'external' | 'internal' | 'unsafe';
function classifyHref(href: string): LinkSafety {
  const trimmed = href.trim();
  if (/^https?:/i.test(trimmed)) return 'external';
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return 'internal';
  return 'unsafe';
}

// A label may map to more than one artifact only if the runner reused a label; the
// last write wins, matching how the evidence band resolves "latest of kind".
function labelIndex(artifacts: readonly Artifact[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const artifact of artifacts) map.set(artifact.label, artifact.id);
  return map;
}

// Resolvable label text → evidence deep link; otherwise the caller's plain node.
function labelLink(
  value: string,
  runId: string,
  labels: Map<string, string>,
  fallback: ReactNode,
): ReactNode {
  const artifactId = labels.get(value.trim());
  if (artifactId === undefined) return fallback;
  return (
    <Link to={evidenceHref(runId, artifactId)} className={LINK_CLASS}>
      {value}
    </Link>
  );
}

function InlineRun({
  inline,
  runId,
  labels,
}: {
  inline: Inline[];
  runId: string;
  labels: Map<string, string>;
}) {
  return (
    <>
      {inline.map((seg, index) => {
        const key = index;
        switch (seg.type) {
          case 'code':
            return (
              <code key={key} className={CODE_CLASS}>
                {seg.value}
              </code>
            );
          case 'strong':
            return (
              <span key={key}>
                {labelLink(
                  seg.value,
                  runId,
                  labels,
                  <strong className="font-semibold text-text-primary">{seg.value}</strong>,
                )}
              </span>
            );
          case 'link': {
            const safety = classifyHref(seg.href);
            if (safety === 'external') {
              return (
                <a
                  key={key}
                  href={seg.href.trim()}
                  target="_blank"
                  rel="noreferrer"
                  className={LINK_CLASS}
                >
                  {seg.text}
                </a>
              );
            }
            if (safety === 'internal') {
              return (
                <Link key={key} to={seg.href.trim()} className={LINK_CLASS}>
                  {seg.text}
                </Link>
              );
            }
            return <span key={key}>{seg.text}</span>;
          }
          case 'text':
          default:
            return (
              <span key={key}>{labelLink(seg.value, runId, labels, seg.value)}</span>
            );
        }
      })}
    </>
  );
}

function BlockNode({
  block,
  runId,
  labels,
}: {
  block: Block;
  runId: string;
  labels: Map<string, string>;
}) {
  const run = (inline: Inline[]) => <InlineRun inline={inline} runId={runId} labels={labels} />;

  switch (block.type) {
    case 'heading': {
      const cls =
        block.level <= 1
          ? 'mt-0 mb-4 text-page font-semibold text-text-primary'
          : block.level === 2
            ? 'mt-8 mb-3 border-b border-border pb-2 text-section font-semibold text-text-primary'
            : 'mt-6 mb-2 text-body font-semibold text-text-primary';
      // Heading level drives semantics AND size; clamp the tag to h1–h4.
      const Tag = (`h${Math.min(block.level, 4)}` as unknown) as 'h1';
      return <Tag className={cls}>{run(block.inline)}</Tag>;
    }
    case 'paragraph':
      return <p className="my-3 text-body leading-relaxed text-text-primary">{run(block.inline)}</p>;
    case 'list':
      return block.ordered ? (
        <ol className="my-3 list-decimal space-y-1 pl-6 text-body leading-relaxed text-text-primary">
          {block.items.map((item, index) => (
            <li key={index}>{run(item)}</li>
          ))}
        </ol>
      ) : (
        <ul className="my-3 list-disc space-y-1 pl-6 text-body leading-relaxed text-text-primary">
          {block.items.map((item, index) => (
            <li key={index}>{run(item)}</li>
          ))}
        </ul>
      );
    case 'table': {
      // GFM alignment hints apply per column; an unspecified column reads left,
      // matching the browser td default and overriding the th centering default.
      const alignClass = (align: TableAlign | null | undefined): string =>
        align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : 'text-left';
      return (
        <div className="my-4 overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="border-b border-border-strong text-text-secondary">
                {block.header.map((cell, index) => (
                  <th key={index} className={`px-3 py-2 font-medium ${alignClass(block.align[index])}`}>
                    {run(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((cells, rowIndex) => (
                <tr key={rowIndex} className="border-b border-border align-top">
                  {cells.map((cell, cellIndex) => (
                    <td key={cellIndex} className={`px-3 py-2 text-text-primary ${alignClass(block.align[cellIndex])}`}>
                      {run(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'code':
      return (
        <pre className="my-4 overflow-x-auto rounded-card border border-border bg-bg-app p-4">
          <code className="font-mono text-meta text-text-primary">{block.text}</code>
        </pre>
      );
    case 'hr':
    default:
      return <hr className="my-6 border-border" />;
  }
}

export function ReportView({ markdown, runId, artifacts }: ReportViewProps) {
  const blocks = parseMarkdown(markdown);
  const labels = labelIndex(artifacts);
  return (
    <article className="rounded-card border border-border bg-bg-panel p-8 shadow-subtle">
      {blocks.map((block, index) => (
        <BlockNode key={index} block={block} runId={runId} labels={labels} />
      ))}
    </article>
  );
}
