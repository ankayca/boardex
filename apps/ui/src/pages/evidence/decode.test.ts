// Decode parsing + row derivation (T3.1). The valid-input cases run against the
// REAL fixture artifacts (packages/contract/fixtures/artifacts) — the same bytes
// the mock runner serves — so the schema can never drift from the fixture shape.
// The nack_at rule under test is binding per fixture-notes.md: only an address
// NACK is a failure; the final-byte NACK of a master read is normal I2C.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeRows,
  foldAnnotationSegments,
  formatSampleTime,
  isTransactionFailed,
  parseProtocolDecode,
} from './decode';

// Vite rewrites import.meta.url to an /@fs/… dev-server URL in the test
// transform; strip the prefix back to a plain filesystem path for readFileSync.
const fixtureArtifact = (name: string): string => {
  const url = new URL(
    `../../../../../packages/contract/fixtures/artifacts/${name}`,
    import.meta.url,
  );
  return readFileSync(decodeURIComponent(url.pathname).replace(/^\/@fs/, ''), 'utf8');
};

describe('parseProtocolDecode', () => {
  it('parses both real fixture decodes', () => {
    const iter1 = parseProtocolDecode(fixtureArtifact('art_i2c_decode_iter1.json'));
    const iter2 = parseProtocolDecode(fixtureArtifact('art_i2c_decode_iter2.json'));
    expect(iter1.ok).toBe(true);
    expect(iter2.ok).toBe(true);
    if (!iter1.ok || !iter2.ok) return;
    expect(iter1.decode.transactions).toHaveLength(3);
    expect(iter2.decode.transactions).toHaveLength(15);
    expect(iter1.decode.sample_rate_hz).toBe(4_000_000);
  });

  it('fails closed on malformed JSON', () => {
    const result = parseProtocolDecode('{ "transactions": [');
    expect(result).toEqual({ ok: false, error: 'Artifact content is not valid JSON.' });
  });

  it('fails closed on empty content', () => {
    expect(parseProtocolDecode('').ok).toBe(false);
  });

  it('fails closed on valid JSON that is not a decode', () => {
    const result = parseProtocolDecode(JSON.stringify({ files: [{ path: 'a.c', diff: '' }] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/protocol-decode shape/);
  });

  it('fails closed on a decode with an invalid transaction field', () => {
    const bad = {
      protocol: 'i2c',
      sample_rate_hz: 4_000_000,
      annotations: [],
      transactions: [{ addr_7bit: 118, rw: 'x', write: [], read: [], nack_at: null }],
    };
    expect(parseProtocolDecode(JSON.stringify(bad)).ok).toBe(false);
  });

  it('accepts an empty transactions array (valid, renders as no transactions)', () => {
    const empty = { protocol: 'i2c', sample_rate_hz: 1000, annotations: [], transactions: [] };
    const result = parseProtocolDecode(JSON.stringify(empty));
    expect(result.ok).toBe(true);
    if (result.ok) expect(decodeRows(result.decode)).toHaveLength(0);
  });
});

describe('the nack_at rule (fixture-notes.md — binding)', () => {
  it('marks a transaction failed ONLY on an address NACK', () => {
    expect(isTransactionFailed({ nack_at: 'address' })).toBe(true);
    expect(isTransactionFailed({ nack_at: 'data' })).toBe(false);
    expect(isTransactionFailed({ nack_at: null })).toBe(false);
  });

  it('renders a master read with a final-byte NACK as an unfailed row', () => {
    const decode = {
      protocol: 'i2c',
      sample_rate_hz: 4_000_000,
      annotations: [],
      transactions: [{ addr_7bit: 118, rw: 'r' as const, write: [], read: [96], nack_at: 'data' as const }],
    };
    const [row] = decodeRows(decode);
    expect(row?.failed).toBe(false);
    expect(row?.ack).toBe('NACK (final byte)');
  });

  it('renders an address NACK as a failed row', () => {
    const decode = {
      protocol: 'i2c',
      sample_rate_hz: 4_000_000,
      annotations: [],
      transactions: [{ addr_7bit: 59, rw: 'w' as const, write: [], read: [], nack_at: 'address' as const }],
    };
    const [row] = decodeRows(decode);
    expect(row?.failed).toBe(true);
    expect(row?.ack).toBe('NACK (address)');
  });

  it('iteration 2 of the real fixture — every successful read — has ZERO failed rows', () => {
    const parsed = parseProtocolDecode(fixtureArtifact('art_i2c_decode_iter2.json'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rows = decodeRows(parsed.decode);
    expect(rows).toHaveLength(15);
    expect(rows.filter((row) => row.failed)).toHaveLength(0);
    // The reads still show their normal final-byte NACK plainly in the ack column.
    expect(rows.filter((row) => row.ack === 'NACK (final byte)')).toHaveLength(6);
  });

  it('groups a write with the read that follows it to the same address (P1 #6)', () => {
    const decode = {
      protocol: 'i2c',
      sample_rate_hz: 4_000_000,
      annotations: [],
      transactions: [
        // set register (write) then read it back (read) at 0x76 — one pair.
        { addr_7bit: 118, rw: 'w' as const, write: [0xd0], read: [], nack_at: null },
        { addr_7bit: 118, rw: 'r' as const, write: [], read: [0x60], nack_at: 'data' as const },
        // a second write to the same address opens its own group (W W stays split).
        { addr_7bit: 118, rw: 'w' as const, write: [0xf4], read: [], nack_at: null },
        // a read at a DIFFERENT address does not pair with the preceding write.
        { addr_7bit: 100, rw: 'r' as const, write: [], read: [0x01], nack_at: 'data' as const },
      ],
    };
    const rows = decodeRows(decode);
    expect(rows.map((row) => row.groupStart)).toEqual([true, false, true, true]);
  });

  it('iteration 1 of the real fixture — the unanswered address — is all failed rows', () => {
    const parsed = parseProtocolDecode(fixtureArtifact('art_i2c_decode_iter1.json'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rows = decodeRows(parsed.decode);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.failed)).toBe(true);
    // 0x76 written unshifted decodes as 7-bit address 0x3B — the bug itself.
    expect(rows[0]?.address).toBe('0x3B');
  });
});

describe('decodeRows derivation', () => {
  it('aligns annotation segments to transactions for time + annotation columns', () => {
    const parsed = parseProtocolDecode(fixtureArtifact('art_i2c_decode_iter1.json'));
    if (!parsed.ok) throw new Error('fixture must parse');
    const rows = decodeRows(parsed.decode);
    // First NACK at sample 812000 @ 4 MHz = 203 ms.
    expect(rows[0]?.time).toBe('203.0 ms');
    expect(rows[0]?.annotation).toContain('ADDRESS WRITE: 76 NACK');
    expect(rows[0]?.rw).toBe('W');
    expect(rows[0]?.data).toBe('—');
  });

  it('splits repeated-start reads into their own rows, like the house parser', () => {
    const parsed = parseProtocolDecode(fixtureArtifact('art_i2c_decode_iter2.json'));
    if (!parsed.ok) throw new Error('fixture must parse');
    const segments = foldAnnotationSegments(parsed.decode.annotations);
    expect(segments).toHaveLength(parsed.decode.transactions.length);
    const rows = decodeRows(parsed.decode);
    // Chip-id read: write D0, repeated start, read 0x60.
    expect(rows[0]?.data).toBe('D0');
    expect(rows[1]?.data).toBe('60');
    expect(rows[1]?.rw).toBe('R');
    // The last row is the read half of the final poll: it begins at its repeated
    // start (sample 3,280,730 @ 4 MHz), not at the write half's START.
    expect(rows[14]?.time).toBe('820.2 ms');
    expect(rows[14]?.annotation).toMatch(/^START REPEAT/);
  });

  it('degrades time to an em dash when the aligned annotation has no sample prefix', () => {
    // parse.py leaves start/end unset for -A lines without a sample-range prefix
    // (sigrok without --protocol-decoder-samplenum); the row must still render.
    const decode = {
      protocol: 'i2c',
      sample_rate_hz: 4_000_000,
      annotations: [
        { raw: 'i2c-1: START', decoder: 'i2c-1', text: 'START' },
        { raw: 'i2c-1: ADDRESS WRITE: 76 ACK', decoder: 'i2c-1', text: 'ADDRESS WRITE: 76 ACK' },
        { raw: 'i2c-1: STOP', decoder: 'i2c-1', text: 'STOP' },
      ],
      transactions: [{ addr_7bit: 59, rw: 'w' as const, write: [], read: [], nack_at: null }],
    };
    const [row] = decodeRows(decode);
    expect(row?.time).toBe('—');
    expect(row?.annotation).toContain('ADDRESS WRITE: 76 ACK');
  });

  it('degrades time/annotation to em dashes when segments cannot align', () => {
    const decode = {
      protocol: 'i2c',
      sample_rate_hz: 1000,
      annotations: [], // no annotations for the one transaction
      transactions: [{ addr_7bit: 118, rw: 'w' as const, write: [208], read: [], nack_at: null }],
    };
    const [row] = decodeRows(decode);
    expect(row?.time).toBe('—');
    expect(row?.annotation).toBe('—');
    expect(row?.data).toBe('D0');
    expect(row?.ack).toBe('ACK');
  });
});

describe('formatSampleTime', () => {
  it('formats under a second as ms and above as s', () => {
    expect(formatSampleTime(812_000, 4_000_000)).toBe('203.0 ms');
    expect(formatSampleTime(3_280_000, 4_000_000)).toBe('820.0 ms');
    expect(formatSampleTime(6_000_000, 4_000_000)).toBe('1.500 s');
  });
});
