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
