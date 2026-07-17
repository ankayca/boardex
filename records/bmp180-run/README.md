# records/bmp180-run

First real-hardware Boardex agent run (`BENCH=agent`), **2026-07-16** — an I2C
bring-up of the BMP180 pressure/temperature sensor on a Nucleo-F303RE, captured
with the runner's `RECORD=` tee. 186 events, 15 artifacts, self-contained
(artifact bodies live in `artifacts/`, referenced by id from the event stream).

**What the stream shows (the honest story):** the firmware functionally worked
— the RTT serial log reads `chip_id=0x55`, `temp=31.9 C`, `press=91754 Pa`. But
the run ended `run.failed` on *"turn bound exceeded: max_turns=40"* with only
**two** checks actually recorded via `record_check` (`build_exit_code` and
`chip_id_rtt`, both pass). The partial report's prose over-claims PASS on four
checks (`temperature_plausible`, `pressure_plausible`, `i2c_device_ack`,
`scl_frequency`) that were never recorded. That evidence-discipline gap — record
every check before the report, and report only what was recorded — is exactly
what motivated the `agent/hardware-run-tuning` prompt and turn-budget fixes.

Tracked as a §10.3 demo/validation asset. Replay it through the UI by pointing
the mock runner at it:

```bash
FIXTURE_FILE=records/bmp180-run/recorded_run.jsonl npm run dev -w tools/mock-runner
```
