// Code-diff parsing (§7.4): the structured-JSON layer and the per-file unified
// diff layer, valid and malformed — both fail closed, never throw. The parser's
// hunk-count tracking is proven against hand-built diffs here and against the
// real fixture diffs the mock runner serves.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  '@@ -182,3 +184,3 @@',
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

  it('parses a two-file diff in one string with correct per-file line arithmetic', () => {
    const twoFiles = [
      '--- a/main.c',
      '+++ b/main.c',
      '@@ -1,2 +1,2 @@',
      ' int main(void) {',
      '-    return 1;',
      '+    return 0;',
      '--- a/i2c.c',
      '+++ b/i2c.c',
      '@@ -10,1 +10,2 @@',
      ' static void i2c_init(void) {',
      '+    /* enable the peripheral clock */',
      '',
    ].join('\n');
    const result = parseUnifiedDiff(twoFiles);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunks).toHaveLength(2);
    // The second file's headers were boundaries, never del/add code lines…
    expect(result.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))).not.toContain(
      '-- a/i2c.c',
    );
    // …and its line numbers restart from its own @@ header, uncorrupted.
    expect(result.hunks[1]?.lines).toEqual([
      { kind: 'context', text: 'static void i2c_init(void) {', oldNo: 10, newNo: 10 },
      { kind: 'add', text: '    /* enable the peripheral clock */', oldNo: null, newNo: 11 },
    ]);
  });

  it('fails closed on a stray file header mid-hunk instead of consuming it as code', () => {
    const stray = ['@@ -1,3 +1,3 @@', ' int main(void) {', '--- a/other.c', ' }', ''].join('\n');
    const result = parseUnifiedDiff(stray);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/File header inside a hunk at line 3/);
  });

  it('preserves a genuine empty context line at a hunk boundary and still drops the trailing newline', () => {
    // Old and new both count 3 lines: the empty line before the trailing
    // newline is the hunk's third context line, not a newline artifact.
    const result = parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n-b\n+c\n\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunks[0]?.lines).toEqual([
      { kind: 'context', text: 'a', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'b', oldNo: 2, newNo: null },
      { kind: 'add', text: 'c', oldNo: null, newNo: 2 },
      { kind: 'context', text: '', oldNo: 3, newNo: 3 },
    ]);
  });

  it('fails closed on text with no hunk headers', () => {
    const result = parseUnifiedDiff('this is not a diff\njust prose\n');
    expect(result).toEqual({ ok: false, error: 'No unified-diff hunks (@@) found.' });
  });

  it('fails closed on an unknown line prefix inside a hunk', () => {
    const result = parseUnifiedDiff('@@ -1,1 +1,1 @@\n?garbage\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unreadable line prefix at line 2/);
  });

  it('fails closed on lines that overrun the hunk’s declared counts', () => {
    const result = parseUnifiedDiff('@@ -1,1 +1,1 @@\n a\n b\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/past the hunk's declared counts at line 3/);
  });

  it('tolerates bare empty lines inside a hunk and no-newline markers', () => {
    const result = parseUnifiedDiff(
      '@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n\\ No newline at end of file\n',
    );
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

describe('parseUnifiedDiff against the real fixture diffs', () => {
  // The base goes through a variable because Vite statically rewrites the
  // literal `new URL('...', import.meta.url)` pattern into an http asset URL
  // in the jsdom test host (same workaround as the mock runner's fixture.ts).
  const moduleUrl = import.meta.url;
  const artifactsDir = fileURLToPath(
    new URL('../../../../../packages/contract/fixtures/artifacts/', moduleUrl),
  );
  const diffFiles = readdirSync(artifactsDir).filter(
    (name) => name.startsWith('art_diff_') && name.endsWith('.json'),
  );

  it('finds the fixture diff artifacts', () => {
    expect(diffFiles.length).toBeGreaterThan(0);
  });

  it.each(diffFiles)('%s parses fully, every hunk consuming its declared counts', (name) => {
    const parsed = parseCodeDiff(readFileSync(artifactsDir + name, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const file of parsed.diff.files) {
      const result = parseUnifiedDiff(file.diff);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.hunks.length).toBeGreaterThan(0);
      for (const hunk of result.hunks) {
        // The parser enforces counts as a ceiling; the fixtures also meet them
        // exactly, so per-file line arithmetic is verifiably complete.
        const [, oldCount, newCount] = /^@@ -\d+,(\d+) \+\d+,(\d+) @@/.exec(hunk.header) ?? [];
        const oldLines = hunk.lines.filter((line) => line.oldNo !== null).length;
        const newLines = hunk.lines.filter((line) => line.newNo !== null).length;
        expect(oldLines).toBe(Number(oldCount));
        expect(newLines).toBe(Number(newCount));
      }
    }
  });
});
