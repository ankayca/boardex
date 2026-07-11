// Minimal Markdown parser for the Validation Report (BIBLE §7.6). The report is a
// runner-authored, fixed-shape document: its section list needs only headings,
// paragraphs, GFM pipe tables, inline code, bold, links, and ordered/unordered
// lists — nothing exotic. Rather than pull in a Markdown library (and still have to
// intercept inline text to resolve artifact-label deep links), we hand-roll the
// subset the report actually uses, matching the house pattern already set by
// diff.ts and highlight.ts. Pure and total: it never throws — an unrecognized line
// degrades to a paragraph — so the page's fail-closed gate only has to guard empty
// or unfetchable content, not a parser crash.

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; value: string }
  | { type: 'link'; text: string; href: string };

export type Block =
  | { type: 'heading'; level: number; inline: Inline[] }
  | { type: 'paragraph'; inline: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { type: 'code'; text: string }
  | { type: 'hr' };

// Inline pass: split a run of text into code spans (`…`), strong spans (**…**),
// explicit links ([text](href)), and plain text. Spans are non-nesting — the report
// never nests inline markup — so the earliest matching marker wins and the rest is
// text. An unterminated marker is left as literal text (fail-soft).
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  let i = 0;
  const flush = () => {
    if (text) {
      out.push({ type: 'text', value: text });
      text = '';
    }
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end !== -1) {
        flush();
        out.push({ type: 'code', value: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '*' && src[i + 1] === '*') {
      const end = src.indexOf('**', i + 2);
      if (end !== -1) {
        flush();
        out.push({ type: 'strong', value: src.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '[') {
      const close = src.indexOf(']', i + 1);
      if (close !== -1 && src[close + 1] === '(') {
        const paren = src.indexOf(')', close + 2);
        if (paren !== -1) {
          flush();
          out.push({
            type: 'link',
            text: src.slice(i + 1, close),
            href: src.slice(close + 2, paren),
          });
          i = paren + 1;
          continue;
        }
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

// A GFM table row split on unescaped pipes, with the optional leading/trailing pipe
// trimmed. Each cell is inline-parsed by the caller.
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((cell) => cell.trim());
}

// The `|---|:--:|` delimiter row that turns two `|`-rows into a table (GFM).
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(trimmed);
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+(.*)$/;
const HR = /^\s*([-*_])\1{2,}\s*$/;

function isBlockBoundary(line: string, next: string | undefined): boolean {
  if (line.trim() === '') return true;
  if (HEADING.test(line)) return true;
  if (LIST_ITEM.test(line)) return true;
  if (HR.test(line)) return true;
  if (line.trim().startsWith('```')) return true;
  if (line.includes('|') && next !== undefined && isTableDelimiter(next)) return true;
  return false;
}

// Block pass: a line-at-a-time dispatch. Blank lines separate blocks; a paragraph
// greedily absorbs following non-boundary lines (soft-wrapped prose joins with a
// space).
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const at = (n: number): string => lines[n] ?? '';
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = at(i);

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    if (line.trim().startsWith('```')) {
      i += 1;
      const buf: string[] = [];
      while (i < lines.length && !at(i).trim().startsWith('```')) {
        buf.push(at(i));
        i += 1;
      }
      if (i < lines.length) i += 1; // consume the closing fence
      blocks.push({ type: 'code', text: buf.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1]!.length,
        inline: parseInline(heading[2]!.trim()),
      });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (line.includes('|') && isTableDelimiter(at(i + 1))) {
      const header = splitTableRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && at(i).trim() !== '' && at(i).includes('|')) {
        rows.push(splitTableRow(at(i)).map(parseInline));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    const firstItem = LIST_ITEM.exec(line);
    if (firstItem) {
      const ordered = /\d+\./.test(firstItem[1]!);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(at(i));
        if (!m || /\d+\./.test(m[1]!) !== ordered) break;
        items.push(parseInline(m[2]!.trim()));
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const buf: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && !isBlockBoundary(at(i), at(i + 1))) {
      buf.push(at(i).trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', inline: parseInline(buf.join(' ')) });
  }

  return blocks;
}
