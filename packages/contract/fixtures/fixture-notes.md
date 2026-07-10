# Fixture notes — `bme280_run_001.jsonl` (T0.3)

Authored fixture per BIBLE §5.5; to be replaced by a genuinely recorded run (§10.3).
Everything below is either a deliberate choice a firmware engineer should verify on the
real bench, or a shape decision downstream tasks should be aware of. Nothing here
changes the contract.

## Verified against this repo

- **Protocol decode shape** (reconciled in T5.0): `annotations` in both
  `art_i2c_decode_iter*.json` are now literally `parse.py::parse_annotations` output —
  `{ raw, start, end, decoder, text }`, where `raw` is the sigrok `-A` line the parser
  would have consumed — verified by feeding each artifact's `raw` lines back through
  the real parser and asserting byte-identical dicts. `transactions` remain verified
  byte-identical against `decode/i2c.py::parse_transactions` over those annotations.
  Annotation `text` carries the **8-bit wire byte** (e.g. `ADDRESS WRITE: 76`), and
  `addr_7bit` is that byte `>> 1`, exactly as the house parser computes it. The wrapper
  fields (`bus_state`, `annotations`, `transactions`, `sample_rate_hz`, …) mirror what
  `decode_bus` documents in `servers/boardex-logic/boardex_logic/server.py`, and the
  whole body validates against the contract's `ProtocolDecodeContent` schema
  (`packages/contract/src/artifacts.ts`, asserted by the fixture test).
- **The bug and the fix compile**: all three firmware states (baseline, iteration 1
  with the unshifted `SADD`, iteration 2 with `BME280_SADD`) pass
  `gcc -fsyntax-only -std=c11 -Wall -Wextra -ffreestanding`; the diffs were generated
  with `diff -u`, not hand-written.
- `device_id` in the decodes (`sigrok:kingst-la2016:conn=3.12`) matches the stable-id
  format the contract's BenchStatus samples use (bible v1.2 amendment).

## Deliberate technical choices to verify on the real bench

1. **pyOCD log lines** (`art_flash_log_iter*.log`): message shapes (`DP IDR`,
   `AHB-AP#0 IDR`, `Erased … programmed … skipped …`, `[loader]` module tags, the
   relative-ms prefix) follow standard `pyocd flash` output. The watchpoint/breakpoint
   counts (6/6) and the `pyocd list` table layout are plausible but unverified against
   the bench's pyOCD version. There is no separate "verify" line: modern pyOCD's loader
   summary (`skipped 0 bytes`) *is* the same-data/verify accounting.
2. **BME280 datasheet section numbers**: §5.4.1 (address/chip id) and §6.2 (interface
   timing) follow the bible's own citations (§5.5 beat 4, contract test samples).
   Verify against the actual datasheet revision on file.
3. **Final read byte NACK is normal**: in every successful I2C read the master NACKs
   the last byte, so passing read transactions carry `nack_at: "data"`. Only
   `nack_at: "address"` means "device did not answer". T3.1's decode table should tint
   on address-NACK, not on any NACK.
4. **Raw BME280 data bytes are representative**: the burst-read bytes and calibration
   constants are typical values, not back-computed through Bosch compensation to yield
   exactly `TEMP=24.3 HUM=41.2`. A recorded fixture will make these self-consistent.
5. **TIMINGR 0x10420F13** is RM0316's standard-mode (100 kHz @ 8 MHz I2CCLK) example
   value; measured 99.6/99.7 kHz is consistent with that config sampled at 4 MHz.
6. **`i2c_clock` evidence** links the `timing_measurement` artifact (per the T0.3 task
   text), not a raw `.sr` logic capture — §5.5 beat 5 says "logic capture artifact"
   loosely. No binary `.sr` file is authored; the recorded fixture should add a real
   `logic_capture` artifact alongside.

## Shape decisions for downstream tasks

- **code_diff artifacts are structured JSON** (`{ files: [{ path, reason, diff }] }`)
  because §4 says decode/diff/timing kinds return structured JSON and §7.4 wants a
  per-file reason line. Since T5.0 this shape is contract-owned
  (`CodeDiffContent` in `packages/contract/src/artifacts.ts`), no longer a proposal.
- **`annotations[].start` / `end`** give the §7.4 decode table its time column (the
  transaction folder only reads `text`). Sample indices are coarse reconstructions
  (~360 samples per byte at 4 MHz). They are `parse_annotations`' own fields, present
  when the sigrok `-A` line carries a sample-range prefix — the previously invented
  `start_sample`/`end_sample` keys are gone (T5.0/F2).
- Artifact files are named `<artifactId>.<ext>` so the mock runner (T0.4) can map ids
  to files without a manifest.
- `sizeBytes` in every `artifact.created` equals the real on-disk file size (asserted
  by the fixture validation test).
