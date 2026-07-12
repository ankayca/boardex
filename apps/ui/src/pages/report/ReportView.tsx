// Renders the parsed Validation Report (BIBLE §7.6) with house typography — this is
// a RENDER of the runner-authored Markdown, never a regeneration: the artifact text
// is the truth, this only adds presentation (§6.1 tokens). Internal references are
// resolved by the evidence-linking law's currency: a text or bold run whose exact
// content matches an artifact label present in RunView.artifacts becomes an evidence
// deep link; anything unresolvable stays plain text — fail-closed, never a dead href.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Artifact, BoardDocument, MeasurementCheck } from '@boardex/contract';
import { evidenceDocHref, evidenceHref } from '../workspace/evidence';
import { parseMarkdown, type Block, type Inline, type TableAlign } from './markdown';

export interface ReportViewProps {
  markdown: string;
  runId: string;
  /** RunView.artifacts — the authority for which label references resolve (§4). */
  artifacts: readonly Artifact[];
  /** RunView.checks (T6.3): a check's sourceRef text deep-links to its sourceDoc. */
  checks?: readonly MeasurementCheck[];
  /** Profile documents (T6.3): a sourceRef link resolves only to a known document. */
  documents?: readonly BoardDocument[];
}

const LINK_CLASS = 'text-accent underline underline-offset-2 hover:text-accent-hover';
const CODE_CLASS = 'rounded bg-neutral-badge-bg px-1 py-0.5 font-mono text-meta text-text-primary';

// The report_md is fetched runner (later: model) output — its link hrefs are as
// untrusted as any user input. Only http(s) URLs and app-internal absolute paths
// (the evidence deep links) render as anchors; every other scheme — javascript:,
// data:, vbscript:, protocol-relative //host — degrades to the link text as plain
// text. Fail-closed: no live script-scheme anchor, and no dead anchor either.
//
// Classification runs on the WHATWG-normalized href, because that is what the
// browser acts on: URL parsing strips ASCII tab/LF/CR anywhere in the input and
// folds \ into / for special schemes, so the raw text /\evil.com or /\t/evil.com
// reads "internal" while actually resolving protocol-relative to evil.com. The
// normalized form is also what gets rendered, so the classified href and the live
// href can never diverge. (%5C needs no handling: percent-escapes are path data,
// decoded only after parsing — /%5Cevil.com stays a same-origin path.)
function normalizeHref(href: string): string {
  return href.trim().replace(/[\t\n\r]/g, '').replace(/\\/g, '/');
}

type LinkSafety = 'external' | 'internal' | 'unsafe';
function classifyHref(normalized: string): LinkSafety {
  if (/^https?:/i.test(normalized)) return 'external';
  if (normalized.startsWith('/') && !normalized.startsWith('//')) return 'internal';
  return 'unsafe';
}

// An index from resolvable link text → app-internal href. Two currencies feed it:
// an artifact LABEL → its evidence deep link (§4, the existing behavior), and a
// check's sourceRef TEXT → its sourceDoc's Sources deep link (T6.3), but only when
// that sourceDoc resolves to a known profile document. Artifact labels win a tie
// (added last), matching the evidence band's "latest of kind" precedence. Nothing
// unresolvable enters the map, so a miss is always a plain-text fallback — never a
// dead link.
function linkIndex(
  runId: string,
  artifacts: readonly Artifact[],
  checks: readonly MeasurementCheck[],
  documents: readonly BoardDocument[],
): Map<string, string> {
  const map = new Map<string, string>();
  const documentIds = new Set(documents.map((doc) => doc.id));
  for (const check of checks) {
    if (check.sourceRef && check.sourceDoc && documentIds.has(check.sourceDoc.documentId)) {
      map.set(check.sourceRef, evidenceDocHref(runId, check.sourceDoc.documentId, check.sourceDoc.locator));
    }
  }
  for (const artifact of artifacts) map.set(artifact.label, evidenceHref(runId, artifact.id));
  return map;
}

// Resolvable link text → its deep link; otherwise the caller's plain node.
function labelLink(value: string, hrefs: Map<string, string>, fallback: ReactNode): ReactNode {
  const href = hrefs.get(value.trim());
  if (href === undefined) return fallback;
  return (
    <Link to={href} className={LINK_CLASS}>
      {value}
    </Link>
  );
}

function InlineRun({ inline, hrefs }: { inline: Inline[]; hrefs: Map<string, string> }) {
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
                  hrefs,
                  <strong className="font-semibold text-text-primary">{seg.value}</strong>,
                )}
              </span>
            );
          case 'link': {
            const href = normalizeHref(seg.href);
            const safety = classifyHref(href);
            if (safety === 'external') {
              return (
                <a
                  key={key}
                  href={href}
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
                <Link key={key} to={href} className={LINK_CLASS}>
                  {seg.text}
                </Link>
              );
            }
            return <span key={key}>{seg.text}</span>;
          }
          case 'text':
          default:
            return <span key={key}>{labelLink(seg.value, hrefs, seg.value)}</span>;
        }
      })}
    </>
  );
}

function BlockNode({ block, hrefs }: { block: Block; hrefs: Map<string, string> }) {
  const run = (inline: Inline[]) => <InlineRun inline={inline} hrefs={hrefs} />;

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

export function ReportView({ markdown, runId, artifacts, checks, documents }: ReportViewProps) {
  const blocks = parseMarkdown(markdown);
  const hrefs = linkIndex(runId, artifacts, checks ?? [], documents ?? []);
  return (
    <article className="rounded-card border border-border bg-bg-panel p-8 shadow-subtle">
      {blocks.map((block, index) => (
        <BlockNode key={index} block={block} hrefs={hrefs} />
      ))}
    </article>
  );
}
