// Markdown subset parser (BIBLE §7.6). The report needs exactly these block and
// inline kinds; each is asserted here at the model level, and the ReportView tests
// prove they render against the real fixture. The parser is total — malformed or
// empty input yields a best-effort model, never a throw — so the page's fail-closed
// gate only guards content, not a crash.
import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, type Block } from './markdown';

describe('parseInline', () => {
  it('splits plain text, inline code, bold, and links', () => {
    expect(parseInline('read `main.c` and **flash it** then [docs](https://x.dev)')).toEqual([
      { type: 'text', value: 'read ' },
      { type: 'code', value: 'main.c' },
      { type: 'text', value: ' and ' },
      { type: 'strong', value: 'flash it' },
      { type: 'text', value: ' then ' },
      { type: 'link', text: 'docs', href: 'https://x.dev' },
    ]);
  });

  it('leaves an unterminated marker as literal text (fail-soft)', () => {
    expect(parseInline('a `b c')).toEqual([{ type: 'text', value: 'a `b c' }]);
    expect(parseInline('a **b c')).toEqual([{ type: 'text', value: 'a **b c' }]);
    expect(parseInline('[x](y')).toEqual([{ type: 'text', value: '[x](y' }]);
    expect(parseInline('[x] no paren')).toEqual([{ type: 'text', value: '[x] no paren' }]);
  });

  it('parses a parenthesized URL whole — the href runs to the balancing paren', () => {
    expect(parseInline('(see [I2C](https://en.wikipedia.org/wiki/I2C_(protocol)))')).toEqual([
      { type: 'text', value: '(see ' },
      { type: 'link', text: 'I2C', href: 'https://en.wikipedia.org/wiki/I2C_(protocol)' },
      { type: 'text', value: ')' },
    ]);
  });

  it('degrades nested and adjacent markers without dropping visible content', () => {
    // Nesting is unsupported by design; the earliest marker wins and the rest stays
    // visible — no throw, no vanished text.
    const flatten = (src: string): string =>
      parseInline(src)
        .map((seg) => (seg.type === 'link' ? seg.text : seg.value))
        .join('');
    expect(flatten('***bold***')).toContain('bold');
    expect(flatten('**`code`**')).toContain('code');
    expect(flatten('`a``b`')).toContain('a');
    expect(flatten('[**x**](https://x.dev)[y]')).toContain('x');
  });

  it('parses a flood of unmatched markers in bounded time with all content intact (never hangs)', () => {
    // Regression guard for the O(n²) rescans: a 1M unmatched-bracket paragraph must
    // parse in linear-ish time. The coarse wall-clock bound is generous for the
    // linear parser (~ms) but far below the quadratic one (~10s benchmarked).
    const src = `${'['.repeat(1_000_000)} tail ${'**'.repeat(5_000)}\`unclosed`;
    const start = performance.now();
    const segments = parseInline(src);
    expect(performance.now() - start).toBeLessThan(1_000);
    const flat = segments
      .map((seg) => (seg.type === 'link' ? seg.text + seg.href : seg.value))
      .join('');
    expect(flat).toContain('tail');
    expect(flat).toContain('unclosed');
  });
});

describe('parseMarkdown', () => {
  it('parses heading levels', () => {
    const blocks = parseMarkdown('# Title\n\n## Section');
    expect(blocks[0]).toEqual({ type: 'heading', level: 1, inline: [{ type: 'text', value: 'Title' }] });
    expect(blocks[1]).toEqual({ type: 'heading', level: 2, inline: [{ type: 'text', value: 'Section' }] });
  });

  it('joins soft-wrapped lines into one paragraph and separates on blank lines', () => {
    const blocks = parseMarkdown('one\ntwo\n\nthree');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'paragraph', inline: [{ type: 'text', value: 'one two' }] });
    expect(blocks[1]).toEqual({ type: 'paragraph', inline: [{ type: 'text', value: 'three' }] });
  });

  it('parses a GFM pipe table with inline markup in cells', () => {
    const md = '| Requirement | Verdict |\n|---|---|\n| `i2c_clock` | **PASS** |';
    const table = parseMarkdown(md)[0] as Extract<Block, { type: 'table' }>;
    expect(table.type).toBe('table');
    expect(table.header).toEqual([
      [{ type: 'text', value: 'Requirement' }],
      [{ type: 'text', value: 'Verdict' }],
    ]);
    expect(table.rows).toEqual([
      [[{ type: 'code', value: 'i2c_clock' }], [{ type: 'strong', value: 'PASS' }]],
    ]);
  });

  it('parses ordered and unordered lists as distinct blocks', () => {
    const blocks = parseMarkdown('1. first\n2. second\n\n- a\n- b');
    const ordered = blocks[0] as Extract<Block, { type: 'list' }>;
    const unordered = blocks[1] as Extract<Block, { type: 'list' }>;
    expect(ordered).toMatchObject({ type: 'list', ordered: true });
    expect(ordered.items).toHaveLength(2);
    expect(unordered).toMatchObject({ type: 'list', ordered: false });
    expect(unordered.items).toHaveLength(2);
  });

  it('parses a fenced code block verbatim', () => {
    const blocks = parseMarkdown('```\nmake clean && make\n```');
    expect(blocks[0]).toEqual({ type: 'code', text: 'make clean && make' });
  });

  it('returns no blocks for empty or whitespace-only input', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
  });
});

describe('parseMarkdown tables (GFM edge cases)', () => {
  const tableOf = (md: string) => parseMarkdown(md)[0] as Extract<Block, { type: 'table' }>;

  it('does not split cells on escaped pipes — \\| renders as a literal pipe', () => {
    const table = tableOf('| Requirement | Expected |\n|---|---|\n| clock | 100 kHz \\| ±10% |');
    expect(table.rows).toEqual([
      [[{ type: 'text', value: 'clock' }], [{ type: 'text', value: '100 kHz | ±10%' }]],
    ]);
  });

  it('does not split cells on pipes inside inline code spans', () => {
    const table = tableOf('| Pattern | Verdict |\n|---|---|\n| `TEMP|HUM` | PASS |');
    expect(table.rows).toEqual([
      [[{ type: 'code', value: 'TEMP|HUM' }], [{ type: 'text', value: 'PASS' }]],
    ]);
  });

  it('records alignment hints from the delimiter row, null when unspecified', () => {
    expect(tableOf('| L | C | R |\n|:---|:---:|---:|\n| a | b | c |').align).toEqual([
      'left',
      'center',
      'right',
    ]);
    expect(tableOf('| a | b |\n|---|---|\n| 1 | 2 |').align).toEqual([null, null]);
  });

  it('requires a pipe in the delimiter: prose + --- stays paragraph + hr, nothing dropped', () => {
    const blocks = parseMarkdown('threshold 5 | measured 3\n---\nnext para');
    expect(blocks).toEqual([
      { type: 'paragraph', inline: [{ type: 'text', value: 'threshold 5 | measured 3' }] },
      { type: 'hr' },
      { type: 'paragraph', inline: [{ type: 'text', value: 'next para' }] },
    ]);
  });

  it('stops rows at a block boundary: a pipe-bearing heading or list after a table is its own block', () => {
    const blocks = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n## Next | section\n- item | with pipe');
    const table = blocks[0] as Extract<Block, { type: 'table' }>;
    expect(table.rows).toHaveLength(1);
    expect(blocks[1]).toMatchObject({ type: 'heading', level: 2 });
    expect(blocks[2]).toMatchObject({ type: 'list', ordered: false });
  });

  it('normalizes ragged rows to header width: overflow folds visibly into the last cell, missing cells render empty', () => {
    const table = tableOf('| a | b |\n|---|---|\n| 1 | 2 | 3 | 4 |\n| only |');
    expect(table.rows[0]).toEqual([
      [{ type: 'text', value: '1' }],
      [{ type: 'text', value: '2 | 3 | 4' }],
    ]);
    expect(table.rows[1]).toEqual([[{ type: 'text', value: 'only' }], []]);
  });

  it('a heading whose inline code contains a pipe stays a heading', () => {
    expect(parseMarkdown('## Match `TEMP|HUM` output')[0]).toEqual({
      type: 'heading',
      level: 2,
      inline: [
        { type: 'text', value: 'Match ' },
        { type: 'code', value: 'TEMP|HUM' },
        { type: 'text', value: ' output' },
      ],
    });
  });

  it('pipe rows without a delimiter degrade to a visible paragraph, not a table and not silence', () => {
    const blocks = parseMarkdown('| a | b |\n| c | d |');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'paragraph' });
    const flat = (blocks[0] as Extract<Block, { type: 'paragraph' }>).inline
      .map((seg) => (seg.type === 'link' ? seg.text : seg.value))
      .join('');
    expect(flat).toContain('a | b');
    expect(flat).toContain('c | d');
  });
});

describe('parseMarkdown totality (never throws on pathological documents)', () => {
  it('parses malformed mixed input without throwing and keeps the content reachable', () => {
    const nasty = [
      '| ragged \\| `code|pipe`',
      '|---|',
      '| a | b | c |',
      '# `a|b` **unterminated',
      '```',
      'unclosed fence | with pipe',
    ].join('\n');
    let blocks: Block[] = [];
    expect(() => {
      blocks = parseMarkdown(nasty);
    }).not.toThrow();
    expect(blocks.length).toBeGreaterThan(0);
    // The unclosed fence content survives as a code block rather than vanishing.
    const code = blocks.find((b) => b.type === 'code') as Extract<Block, { type: 'code' }>;
    expect(code.text).toContain('unclosed fence | with pipe');
  });

  it('parses a 10k unclosed-bracket document in bounded time', () => {
    const start = performance.now();
    const blocks = parseMarkdown(`# Title\n\n${'['.repeat(10_000)}`);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(blocks[1]).toEqual({
      type: 'paragraph',
      inline: [{ type: 'text', value: '['.repeat(10_000) }],
    });
  });
});
