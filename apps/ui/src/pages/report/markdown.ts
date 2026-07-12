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

export type TableAlign = 'left' | 'center' | 'right';

export type Block =
  | { type: 'heading'; level: number; inline: Inline[] }
  | { type: 'paragraph'; inline: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'table'; header: Inline[][]; align: (TableAlign | null)[]; rows: Inline[][][] }
  | { type: 'code'; text: string }
  | { type: 'hr' };

// An href scan is bounded so a paren flood costs O(cap) per link attempt, not O(n):
// far beyond any real URL, small enough to keep pathological input effectively linear.
const HREF_SCAN_CAP = 2048;

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
  // Memoized monotone closer searches: scan starts only move forward, so a hit at
  // index m stays valid for any later start ≤ m and a miss is final. A flood of
  // unmatched markers ('['.repeat(n)…) costs one scan total, not one per marker —
  // the pass stays linear instead of O(n²).
  const finder = (needle: string) => {
    let hit = -2; // -2 = not yet searched, -1 = exhausted
    return (from: number): number => {
      if (hit === -1) return -1;
      if (hit < from) hit = src.indexOf(needle, from);
      return hit;
    };
  };
  const nextBacktick = finder('`');
  const nextStrong = finder('**');
  const nextBracketClose = finder(']');
  while (i < src.length) {
    const ch = src[i];
    if (ch === '`') {
      const end = nextBacktick(i + 1);
      if (end !== -1) {
        flush();
        out.push({ type: 'code', value: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '*' && src[i + 1] === '*') {
      const end = nextStrong(i + 2);
      if (end !== -1) {
        flush();
        out.push({ type: 'strong', value: src.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '[') {
      const close = nextBracketClose(i + 1);
      if (close !== -1 && src[close + 1] === '(') {
        // The href runs to the paren that balances the opener, so URLs containing
        // parentheses ("…/I2C_(protocol)") parse whole instead of truncating at the
        // first ')'. An unbalanced (or cap-exceeding) open degrades to literal text.
        let depth = 1;
        let j = close + 2;
        const limit = Math.min(src.length, close + 2 + HREF_SCAN_CAP);
        while (j < limit && depth > 0) {
          if (src[j] === '(') depth += 1;
          else if (src[j] === ')') depth -= 1;
          j += 1;
        }
        if (depth === 0) {
          flush();
          out.push({
            type: 'link',
            text: src.slice(i + 1, close),
            href: src.slice(close + 2, j - 1),
          });
          i = j;
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
// trimmed. An escaped pipe (\|) is a literal | in the cell, and a pipe inside a
// closed backtick code span stays in its cell — neither is a boundary. Each cell is
// inline-parsed by the caller.
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cell += '|';
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end !== -1) {
        cell += s.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  cells.push(cell.trim());
  return cells;
}

// The `|---|:--:|` delimiter row that turns two `|`-rows into a table (GFM). It must
// contain at least one pipe: a bare `---` is a thematic break, not a table — without
// this, prose containing a pipe followed by an hr would silently become a table.
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(trimmed);
}

// GFM alignment hints from the delimiter row: `:---` left, `:---:` center, `---:`
// right, bare `---` unspecified (null — the renderer picks its default).
function parseAlignments(delimiter: string): (TableAlign | null)[] {
  return splitTableRow(delimiter).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
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
      const headerCells = splitTableRow(line);
      const width = headerCells.length;
      const align = parseAlignments(at(i + 1)).slice(0, width);
      while (align.length < width) align.push(null);
      i += 2;
      // A ragged row is normalized to the header's width so cells never shift under
      // the wrong column: overflow folds visibly into the last cell (never silently
      // dropped), missing cells render empty.
      const normalize = (cells: string[]): string[] => {
        if (cells.length > width) {
          return [...cells.slice(0, width - 1), cells.slice(width - 1).join(' | ')];
        }
        while (cells.length < width) cells.push('');
        return cells;
      };
      const rows: Inline[][][] = [];
      // Rows end at any block boundary, not just a blank or pipe-less line — a
      // heading, list, or fence containing a pipe starts its own block.
      while (i < lines.length && at(i).includes('|') && !isBlockBoundary(at(i), at(i + 1))) {
        rows.push(normalize(splitTableRow(at(i))).map(parseInline));
        i += 1;
      }
      blocks.push({ type: 'table', header: headerCells.map(parseInline), align, rows });
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
