// Code-diff parsing (§7.4): the structured-JSON layer and the per-file unified
// diff layer, valid and malformed — both fail closed, never throw.
import { describe, expect, it } from 'vitest';
import { parseCodeDiff, parseUnifiedDiff } from './diff';

const FILE_DIFF = [
  '--- a/main.c',
  '+++ b/main.c',
  '@@ -60,3 +60,5 @@',
  ' /* BME280 breakout, SDO tied low -> 7-bit address 0x76 (datasheet 5.4.1). */',
  ' #define BME280_ADDR 0x76U',
  '+/* I2C1 CR2 SADD[7:1] carries the 7-bit address as the wire byte: shift it. */',
  '+#define BME280_SADD ((uint32_t)BME280_ADDR << 1)',
  ' #define BME280_CHIP_ID 0x60U',
  '@@ -182,7 +184,7 @@',
  ' static int bme280_write_reg(uint8_t reg, uint8_t val) {',
  '-    I2C1_CR2 = (uint32_t)BME280_ADDR | (2U << 16);',
  '+    I2C1_CR2 = BME280_SADD | (2U << 16);',
  '     if (i2c1_wait(I2C_ISR_TXIS, "TXIS (write reg)") != 0) {',
  '',
].join('\n');

describe('parseCodeDiff', () => {
  it('parses the { files: [{ path, reason, diff }] } shape', () => {
    const result = parseCodeDiff(
      JSON.stringify({ files: [{ path: 'main.c', reason: 'Fix the address.', diff: FILE_DIFF }] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diff.files).toHaveLength(1);
      expect(result.diff.files[0]?.path).toBe('main.c');
      expect(result.diff.files[0]?.reason).toBe('Fix the address.');
    }
  });

  it('fails closed on non-JSON content', () => {
    const result = parseCodeDiff('--- a/main.c\n+++ b/main.c');
    expect(result).toEqual({ ok: false, error: 'Artifact content is not valid JSON.' });
  });

  it('fails closed on JSON that misses the code-diff shape, naming the path', () => {
    const result = parseCodeDiff(JSON.stringify({ files: [{ path: 'main.c' }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/code-diff shape \(at files\.0\./);
  });
});

describe('parseUnifiedDiff', () => {
  it('parses hunks with typed lines and running old/new line numbers', () => {
    const result = parseUnifiedDiff(FILE_DIFF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunks).toHaveLength(2);

    const [first, second] = result.hunks;
    expect(first?.header).toBe('@@ -60,3 +60,5 @@');
    expect(first?.lines.map((line) => line.kind)).toEqual([
      'context',
      'context',
      'add',
      'add',
      'context',
    ]);
    // Adds carry only new-file numbers; the context after them re-syncs both.
    expect(first?.lines[2]).toMatchObject({ kind: 'add', oldNo: null, newNo: 62 });
    expect(first?.lines[4]).toMatchObject({ kind: 'context', oldNo: 62, newNo: 64 });

    expect(second?.lines.map((line) => line.kind)).toEqual(['context', 'del', 'add', 'context']);
    expect(second?.lines[1]).toMatchObject({ kind: 'del', oldNo: 183, newNo: null });
  });

  it('fails closed on text with no hunk headers', () => {
    const result = parseUnifiedDiff('this is not a diff\njust prose\n');
    expect(result).toEqual({ ok: false, error: 'No unified-diff hunks (@@) found.' });
  });

  it('fails closed on an unknown line prefix inside a hunk', () => {
    const result = parseUnifiedDiff('@@ -1,1 +1,1 @@\n?garbage\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unreadable diff line 2/);
  });

  it('tolerates bare empty lines inside a hunk and no-newline markers', () => {
    const result = parseUnifiedDiff('@@ -1,2 +1,2 @@\n a\n\n-b\n+c\n\\ No newline at end of file\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunks[0]?.lines.map((line) => line.kind)).toEqual([
      'context',
      'context',
      'del',
      'add',
    ]);
  });
});
