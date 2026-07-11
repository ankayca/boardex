// The Code Diff tab's minimal C tokenizer: token classes only — colors are the
// renderer's business (and stay inside §6.1 per decisions.md 2026-07-09).
import { describe, expect, it } from 'vitest';
import { tokenizeC } from './highlight';

describe('tokenizeC', () => {
  it('marks a whole preprocessor line as preproc', () => {
    expect(tokenizeC('#define BME280_ADDR 0x76U')).toEqual([
      { text: '#define BME280_ADDR 0x76U', kind: 'preproc' },
    ]);
  });

  it('classifies keywords, *_t typedef names, strings, and comments', () => {
    const tokens = tokenizeC('static int n = read("x"); /* count */');
    expect(tokens).toContainEqual({ text: 'static', kind: 'keyword' });
    expect(tokens).toContainEqual({ text: 'int', kind: 'keyword' });
    expect(tokens).toContainEqual({ text: '"x"', kind: 'string' });
    expect(tokens).toContainEqual({ text: '/* count */', kind: 'comment' });
    expect(tokenizeC('uint32_t spin;')[0]).toEqual({ text: 'uint32_t', kind: 'keyword' });
  });

  it('does not tokenize inside strings or line comments', () => {
    expect(tokenizeC('uart2_write("timeout waiting for int");')).toContainEqual({
      text: '"timeout waiting for int"',
      kind: 'string',
    });
    const [comment] = tokenizeC('// return early if void');
    expect(comment).toEqual({ text: '// return early if void', kind: 'comment' });
  });

  it('round-trips: concatenated token text reproduces the line', () => {
    const line = '    for (uint32_t i = 0; i < n; i++) { dst[i] = (uint8_t)I2C1_RXDR; }';
    expect(
      tokenizeC(line)
        .map((token) => token.text)
        .join(''),
    ).toBe(line);
  });
});
