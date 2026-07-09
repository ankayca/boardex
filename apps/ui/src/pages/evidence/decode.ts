// Protocol-decode parsing + row derivation (BIBLE §7.4, fixture-notes.md).
//
// The artifact is sigrok-shaped JSON verified byte-identical to the house parser's
// output (servers/boardex-logic/.../decode/i2c.py::parse_transactions). Two rules
// from fixture-notes.md are binding here:
//   1. A transaction FAILED — fail bg tint — ONLY when nack_at === "address"
//      ("device did not answer"). The final-byte NACK on a master read is normal
//      I2C protocol: `nack_at: "data"` renders as an ordinary row, no red.
//   2. annotations[].start_sample exists specifically to give the table its time
//      column; transactions themselves carry no sample indices, so annotations are
//      folded into per-transaction segments with the house parser's boundary rules
//      and aligned to transactions[] by index.
// Malformed or unparseable content resolves to { ok: false } — the tab renders a
// fail-closed error state, never a crash, never a silently empty table.
import { z } from 'zod';

const AnnotationSchema = z.object({
  start_sample: z.number().int().nonnegative(),
  end_sample: z.number().int().nonnegative(),
  text: z.string(),
});
export type DecodeAnnotation = z.infer<typeof AnnotationSchema>;

const TransactionSchema = z.object({
  addr_7bit: z.number().int().nonnegative().nullable(),
  rw: z.enum(['r', 'w']).nullable(),
  write: z.array(z.number().int().nonnegative()),
  read: z.array(z.number().int().nonnegative()),
  nack_at: z.enum(['address', 'data']).nullable(),
});
export type DecodeTransaction = z.infer<typeof TransactionSchema>;

// The wrapper fields the table consumes, matching the fixture / decode_bus shape.
// Unknown extra fields (device_id, channel_map, bus_state, …) pass through Zod's
// default stripping — the schema is a reader, not a validator of the full wrapper.
export const ProtocolDecodeSchema = z.object({
  protocol: z.string(),
  sample_rate_hz: z.number().positive(),
  annotations: z.array(AnnotationSchema),
  transactions: z.array(TransactionSchema),
});
export type ProtocolDecode = z.infer<typeof ProtocolDecodeSchema>;

export type DecodeParseResult =
  | { ok: true; decode: ProtocolDecode }
  | { ok: false; error: string };

export function parseProtocolDecode(text: string): DecodeParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Artifact content is not valid JSON.' };
  }
  const parsed = ProtocolDecodeSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (at ${issue.path.join('.')})` : '';
    return {
      ok: false,
      error: `Artifact JSON does not match the protocol-decode shape${where}.`,
    };
  }
  return { ok: true, decode: parsed.data };
}

// THE correctness rule (fixture-notes.md §3): only an address NACK is a failure.
export function isTransactionFailed(tx: Pick<DecodeTransaction, 'nack_at'>): boolean {
  return tx.nack_at === 'address';
}

interface AnnotationSegment {
  startSample: number;
  texts: string[];
}

// Mirror of the house parser's transaction boundaries (i2c.py), reduced to
// grouping: START begins a segment (discarding an unfinished one, as the house
// parser does), a repeated start finalizes the previous segment, STOP finalizes.
// A segment counts only if it saw an ADDRESS or DATA annotation — the same
// condition under which the house parser emits a transaction — so segments align
// index-for-index with transactions[].
const ADDR_RE = /^ADDRESS\s+(?:READ|WRITE):\s*[0-9A-Fa-f]{1,2}\s*(?:ACK|NACK)?$/i;
const DATA_RE = /^DATA\s+(?:READ|WRITE)?:?\s*[0-9A-Fa-f]{1,2}\s*(?:ACK|NACK)?$/i;
const START_VARIANTS = new Set(['START REPEAT', 'REPEATED START', 'RESTART']);

export function foldAnnotationSegments(
  annotations: readonly DecodeAnnotation[],
): AnnotationSegment[] {
  const segments: AnnotationSegment[] = [];
  let current: (AnnotationSegment & { populated: boolean }) | null = null;

  const finalize = () => {
    if (current?.populated) segments.push({ startSample: current.startSample, texts: current.texts });
    current = null;
  };

  for (const annotation of annotations) {
    const text = annotation.text.trim();
    if (!text) continue;
    const upper = text.toUpperCase();

    if (upper === 'START' || START_VARIANTS.has(upper)) {
      if (upper !== 'START') finalize();
      current = { startSample: annotation.start_sample, texts: [text], populated: false };
      continue;
    }
    if (upper === 'STOP') {
      if (current) {
        current.texts.push(text);
        finalize();
      }
      continue;
    }
    if (!current) {
      current = { startSample: annotation.start_sample, texts: [], populated: false };
    }
    current.texts.push(text);
    if (ADDR_RE.test(text) || DATA_RE.test(text)) current.populated = true;
  }
  finalize();
  return segments;
}

// "203.0 ms" under a second, "3.281 s" above — dense but scannable.
export function formatSampleTime(sample: number, sampleRateHz: number): string {
  const seconds = sample / sampleRateHz;
  return seconds < 1 ? `${(seconds * 1000).toFixed(1)} ms` : `${seconds.toFixed(3)} s`;
}

const hexByte = (value: number): string =>
  value.toString(16).toUpperCase().padStart(2, '0');

export interface DecodeRow {
  time: string;
  address: string;
  rw: string;
  ack: string;
  data: string;
  annotation: string;
  /** Fail bg tint ONLY when the device did not answer (address NACK). */
  failed: boolean;
}

// One table row per transaction. Time and annotation come from the aligned
// annotation segment; if the fold doesn't align one-to-one with transactions[]
// (an unexpected decoder shape), those two columns degrade to em dashes rather
// than mislabeling rows.
export function decodeRows(decode: ProtocolDecode): DecodeRow[] {
  const segments = foldAnnotationSegments(decode.annotations);
  const aligned = segments.length === decode.transactions.length;

  return decode.transactions.map((tx, index) => {
    const segment = aligned ? segments[index] : undefined;
    const bytes = [...tx.write, ...tx.read];
    return {
      time: segment ? formatSampleTime(segment.startSample, decode.sample_rate_hz) : '—',
      address: tx.addr_7bit !== null ? `0x${hexByte(tx.addr_7bit)}` : '—',
      rw: tx.rw !== null ? tx.rw.toUpperCase() : '—',
      ack:
        tx.nack_at === 'address'
          ? 'NACK (address)'
          : tx.nack_at === 'data'
            ? tx.rw === 'r'
              ? 'NACK (final byte)'
              : 'NACK (data)'
            : 'ACK',
      data: bytes.length > 0 ? bytes.map(hexByte).join(' ') : '—',
      annotation: segment ? segment.texts.join(' · ') : '—',
      failed: isTransactionFailed(tx),
    };
  });
}
