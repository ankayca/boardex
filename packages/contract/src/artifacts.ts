// Structured artifact content schemas (BIBLE §4: decode/diff/timing kinds return
// structured JSON) — promoted into the contract in T5.0 so both runners and the UI
// share one shape instead of the UI keeping private readers (audit F2).
//
// The protocol_decode shape is reconciled to the house pipeline in
// servers/boardex-logic: annotations are exactly what parse.py::parse_annotations
// yields ({ raw, start?, end?, decoder?, text }), and transactions are exactly what
// decode/i2c.py::parse_transactions folds them into. Nothing here is invented — a
// recorded run's decode artifact is the adapter's output, verbatim.
import { z } from 'zod';

// One sigrok -A annotation line as parse.py returns it. `raw` is always the whole
// line; `start`/`end` are sample indices when the line carried a range prefix
// ("812000-812010 i2c-1: START"); `decoder` is the tag before the colon when there
// was one; `text` is the message (parse.py sets it on every line).
export const DecodeAnnotationSchema = z.object({
  raw: z.string(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  decoder: z.string().optional(),
  text: z.string(),
});
export type DecodeAnnotation = z.infer<typeof DecodeAnnotationSchema>;

// One folded I2C transaction (decode/i2c.py). nack_at "address" means the device
// did not answer; "data" on a master read's final byte is normal I2C protocol.
export const I2cTransactionSchema = z.object({
  addr_7bit: z.number().int().nonnegative().nullable(),
  rw: z.enum(['r', 'w']).nullable(),
  write: z.array(z.number().int().nonnegative()),
  read: z.array(z.number().int().nonnegative()),
  nack_at: z.enum(['address', 'data']).nullable(),
});
export type I2cTransaction = z.infer<typeof I2cTransactionSchema>;

export const BusStateSchema = z.enum(['idle_bus', 'activity_no_decode', 'decoded_ok']);
export type BusState = z.infer<typeof BusStateSchema>;

// The protocol_decode artifact: what decode_bus (servers/boardex-logic/server.py)
// returns for a capture, stored by reference. I2C is the MVP's only structured
// transaction shape (decode/__init__.py maps only "i2c"); other protocols carry
// annotations with an empty transactions array.
export const ProtocolDecodeContentSchema = z.object({
  protocol: z.string(),
  device_id: z.string().optional(),
  channel_map: z.record(z.number().int()).optional(),
  sample_rate_hz: z.number().positive(),
  num_samples: z.number().int().positive().optional(),
  duration_s: z.number().positive().optional(),
  bus_state: BusStateSchema.optional(),
  trigger_channel: z.number().int().nullable().optional(),
  trigger_edge: z.string().nullable().optional(),
  annotations: z.array(DecodeAnnotationSchema),
  transactions: z.array(I2cTransactionSchema),
});
export type ProtocolDecodeContent = z.infer<typeof ProtocolDecodeContentSchema>;

// The code_diff artifact: per-file unified diffs with the §7.4 per-file reason line.
export const DiffFileSchema = z.object({
  path: z.string(),
  reason: z.string(),
  diff: z.string(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const CodeDiffContentSchema = z.object({
  files: z.array(DiffFileSchema),
});
export type CodeDiffContent = z.infer<typeof CodeDiffContentSchema>;

// The timing_measurement artifact: one measured value against the checks' window.
export const TimingMeasurementContentSchema = z.object({
  measurement: z.string(),
  valueHz: z.number().positive(),
});
export type TimingMeasurementContent = z.infer<typeof TimingMeasurementContentSchema>;
