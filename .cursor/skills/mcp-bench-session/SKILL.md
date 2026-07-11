---
name: mcp-bench-session
description: Drive real bench hardware through the boardex-target and boardex-logic MCP servers — flash firmware, stream RTT, capture and decode buses. Use when asked to flash a board, run a bring-up checkpoint, capture I2C/SPI/UART, debug RTT/serial output, or otherwise touch the physical bench.
---

# Driving the bench via the Boardex MCP servers

`.cursor/mcp.json` wires two stdio servers spawned from the repo venv:
`boardex-target` (flash/debug, pyOCD built in) and `boardex-logic` (sigrok
capture + decode). If their tools are missing, the venv or editable installs
are broken — fix per the `pytest-servers` skill, then reload MCP servers in
Cursor settings.

## Ground rules

- **Branch on `verdict`**, never on prose. Every tool returns an
  `OperationResult` dict: `verdict` is `pass`/`fail`/`error`/`inconclusive`,
  payload under `data`, diagnostics under `error`.
- **Device ids are namespaced** (`pyocd:...`, `sigrok:kingst-la2016:conn=3.7`).
  Always discover them via `list_targets` / `list_analyzers` first; empty
  `data.backends` means the vendor tooling is missing or nothing is plugged in.
- Hardware ops are stateful and physical: no retry loops on `error` verdicts
  without a new hypothesis. `recover_target` exists for wedged probes.

## Typical flows

**Bring-up checkpoint (preferred — one call, bundled evidence):**
`run_checkpoint(device_id, rtt_pattern, project_dir=..., inspect_on_failure="I2C1")`
builds → flashes → waits for the RTT pattern; on timeout it inspects the named
peripheral and attaches decoded registers/pins/hints to `data.evidence`.
Branch on `data.evidence.verdict` and `data.evidence.rtt.matched`. It opens a
session when `session_id` is omitted and leaves it open — reuse
`data.session_id`. `verify_bringup` is the related full-loop variant.

**Manual loop (when you need finer control):**
1. `list_targets` → pick `device_id`
2. `build_firmware` / `flash_firmware`
3. `open_session` → `start_rtt` → `wait_for_rtt` / `read_rtt` → `stop_rtt`
4. `read_firmware_log` for serial, `inspect_peripheral` for on-chip state,
   `read_memory` / `read_chip_status` for diagnostics
5. `close_session` when done (sessions hold the probe)

**Bus verification (coordinate both servers):**
1. `list_analyzers` → `get_capabilities` (valid sample rates, triggers)
2. For traffic right after boot: arm `capture_during` (trigger-armed, defaults
   to SCL-falling for I2C) and call `reset_target` on the MCU immediately
   before, so the window covers first post-reset activity.
3. Otherwise `decode_bus` (protocol + channel_map, e.g. `{"scl": 0, "sda": 1}`;
   sample at ≥4x the bus clock) or raw `capture` (branch on
   `data.measurements`: `active`, `frequency_hz`, `duty_cycle`,
   `min_pulse_width_s`).
4. `inconclusive` with `bus_state: idle_bus` → firmware isn't driving the bus;
   `activity_no_decode` → wrong channel map or sample rate too low.

## Scope

These MCP servers are the tool layer — the §5 UI contract does NOT apply to
them (BIBLE §10.0). Approval/stop semantics belong to the future
`servers/boardex-runner` orchestrator, not to raw bench calls.
