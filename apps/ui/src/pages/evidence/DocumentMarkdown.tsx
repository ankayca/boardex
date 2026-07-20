// Renders a markdown document for the Sources tab (§7.4, T6.3) using the same
// hand-rolled parser as the Validation Report (T5.1). Two things the report renderer
// does not need: every heading gets a GitHub-style slug id, and when a locator is
// given the matching heading is scrolled into view and highlighted — that is how a
// check's sourceDoc.locator deep-links to the exact section. A locator that matches
// no heading is a no-op (best-effort, never an error): the document still renders.
import { useEffect, useRef } from 'react';
import { parseMarkdown, type Block, type Inline } from '../report/markdown';
import { slugify } from './slug';

// Plain text of an inline run — for computing a heading's slug and for rendering
// (documents carry no artifact-label deep links, so inline markup renders literally).
function plainInline(inline: Inline[]): string {
  return inline
    .map((seg) => (seg.type === 'link' ? seg.text : seg.value))
    .join('');
}

function InlineRun({ inline }: { inline: Inline[] }) {
  return (
    <>
      {inline.map((seg, index) => {
        switch (seg.type) {
          case 'code':
            return (
              <code
                key={index}
                className="rounded bg-neutral-badge-bg px-1 py-0.5 font-mono text-meta text-text-primary"
              >
                {seg.value}
              </code>
            );
          case 'strong':
            return (
              <strong key={index} className="font-semibold text-text-primary">
                {seg.value}
              </strong>
            );
          case 'link':
            // Documents are reference material — render link text, not a live anchor.
            return <span key={index}>{seg.text}</span>;
          case 'text':
          default:
            return <span key={index}>{seg.value}</span>;
        }
      })}
    </>
  );
}

export interface DocumentMarkdownProps {
  markdown: string;
  /** A sourceDoc locator (a heading slug); highlights + scrolls to that heading. */
  locator: string | null;
}

export function DocumentMarkdown({ markdown, locator }: DocumentMarkdownProps) {
  const blocks = parseMarkdown(markdown);
  const locatedRef = useRef<HTMLHeadingElement | null>(null);

  // Scroll the located heading into view when the locator resolves. jsdom has no
  // layout, so scrollIntoView may be absent or throw — guard it; the highlight
  // (below, via data-located) is the testable, always-present signal.
  useEffect(() => {
    const el = locatedRef.current;
    if (!el) return;
    try {
      el.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    } catch {
      /* no layout engine — the highlight still lands */
    }
  }, [locator]);

  return (
    <article className="max-w-none">
      {blocks.map((block, index) => (
        <DocumentBlock key={index} block={block} locator={locator} locatedRef={locatedRef} />
      ))}
    </article>
  );
}

function DocumentBlock({
  block,
  locator,
  locatedRef,
}: {
  block: Block;
  locator: string | null;
  locatedRef: React.MutableRefObject<HTMLHeadingElement | null>;
}) {
  switch (block.type) {
    case 'heading': {
      const slug = slugify(plainInline(block.inline));
      const located = locator !== null && slug === locator;
      const size =
        block.level <= 1
          ? 'mt-0 mb-4 text-page font-semibold'
          : block.level === 2
            ? 'mt-8 mb-3 border-b border-border pb-2 text-section font-semibold'
            : 'mt-6 mb-2 text-body font-semibold';
      // A located heading gets an accent left-rail highlight over a neutral tint
      // (accent is the one action/highlight color; the tint is neutral — not a
      // green/red/amber semantic, D14 intact).
      const highlight = located
        ? 'scroll-mt-4 rounded-r border-l-2 border-accent bg-neutral-badge-bg pl-3 -ml-3'
        : '';
      const Tag = (`h${Math.min(block.level, 4)}` as unknown) as 'h2';
      return (
        <Tag
          id={slug}
          data-located={located ? 'true' : undefined}
          ref={located ? locatedRef : undefined}
          className={`${size} ${highlight} text-text-primary`}
        >
          <InlineRun inline={block.inline} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p className="my-3 text-body leading-relaxed text-text-primary">
          <InlineRun inline={block.inline} />
        </p>
      );
    case 'list':
      return block.ordered ? (
        <ol className="my-3 list-decimal space-y-1 pl-6 text-body leading-relaxed text-text-primary">
          {block.items.map((item, index) => (
            <li key={index}>
              <InlineRun inline={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="my-3 list-disc space-y-1 pl-6 text-body leading-relaxed text-text-primary">
          {block.items.map((item, index) => (
            <li key={index}>
              <InlineRun inline={item} />
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="my-4 overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="border-b border-border-strong text-text-secondary">
                {block.header.map((cell, index) => (
                  <th key={index} className="px-3 py-2 text-left font-medium">
                    <InlineRun inline={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((cells, rowIndex) => (
                <tr key={rowIndex} className="border-b border-border align-top">
                  {cells.map((cell, cellIndex) => (
                    <td key={cellIndex} className="px-3 py-2 text-text-primary">
                      <InlineRun inline={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'code':
      return (
        <pre className="my-4 overflow-x-auto rounded-card border border-border bg-canvas p-4">
          <code className="font-mono text-meta text-text-primary">{block.text}</code>
        </pre>
      );
    case 'hr':
    default:
      return <hr className="my-6 border-border" />;
  }
}
