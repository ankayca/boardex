# boardex-target

MCP server that lets a Boardex agent **flash and debug MCU targets** over standard
debug probes. First backend: [pyOCD] (ST-Link, CMSIS-DAP). J-Link / OpenOCD /
STM32CubeProgrammer are future adapters that plug in without changing any tool.

## Tools exposed to the agent

| Tool | What it does |
|---|---|
| `list_targets` | Discover connected debug probes / MCU targets |
| `build_firmware` | Build an external firmware project, capture errors, return the artifact |
| `flash_firmware` | Program a `.elf`/`.hex`/`.bin` and reset |
| `reset_target` | Reset (optionally halt after reset) |
| `halt_target` / `resume_target` | Stop / start the CPU core |
| `read_memory` / `write_memory` | Peek/poke target memory (hex payloads) |
| `inspect_peripheral` | Decode a live on-chip peripheral (registers, pin mux, clocks, hints) |
| `read_firmware_log` | One-shot: drain SEGGER RTT output for a timeout |
| `recover_target` | Reclaim a wedged board: connect-under-reset + mass-erase |
| `read_chip_status` | Core state/PC + decoded Cortex-M fault, source-mapped via the ELF |
| `open_session` / `close_session` / `list_sessions` | Manage persistent debug sessions |
| `start_rtt` / `read_rtt` / `stop_rtt` | Background RTT streaming on an open session |
| `wait_for_rtt` | Block until a pattern appears in the RTT stream (or timeout) |
| `prepare_session` | Discard stale RTT output before a fresh run (session hygiene) |
| `run_checkpoint` | Composite: build → flash → wait-for-RTT with bundled evidence |
| `verify_bringup` | Composite: checkpoint + optional logic-analyzer I2C bus proof |

Every tool returns an `OperationResult` (`verdict`, `summary`, `data`, ...).

## Source-mapped everything (ELF awareness)

`flash_firmware` remembers the last `.elf` it flashed to each device, so the
other tools turn raw addresses into **source locations** with no extra arguments:

- `read_chip_status` resolves the current and *faulting* PCs to
  `function (file:line)` (`data.fault_location`). The faulting PC comes from the
  auto-stacked Cortex-M exception frame, which is only readable when halted — for
  a running crashed core, call `read_chip_status(halt=True)` for a one-shot dump
  (it halts the already-crashed core and leaves it halted).
- `read_firmware_log` / `start_rtt` locate the SEGGER RTT control block from the
  firmware's `_SEGGER_RTT` symbol automatically (no `control_block_address`).

Pass `elf_path=` explicitly to any of these to override the remembered image.
Symbol names come from `.symtab`; `file:line` needs the firmware built with `-g`.

## The closed loop: build → flash → run → diagnose → recover

`build_firmware` runs a firmware project's *own* build command and is
framework/vendor-neutral: it auto-detects `make`/`cmake`/PlatformIO (or takes an
explicit `command`), scrapes gcc-style errors/warnings into structured records,
and returns the built image in `data.artifact_path` — ready to hand straight to
`flash_firmware`. Firmware lives *outside* this repo; pass an absolute path.

```python
b = build_firmware(project_dir="/abs/path/myfw", env={"CROSS": "/abs/tc/arm-none-eabi-"})
flash_firmware(device_id=dev, firmware_path=b["data"]["artifact_path"], target="stm32f303retx")
```

`read_chip_status` is non-intrusive introspection so the agent can tell
"crashed (and why)" apart from "just silent": it reports run state and PC, and
decodes the Cortex-M fault registers (CFSR/HFSR/BFAR) into `data.faults.reason`.
`data.faulted` / `data.in_fault_handler` flag a crash; with the ELF it also gives
`data.fault_location` (e.g. `i2c_write (i2c.c:42)`). See "Source-mapped
everything" above for the `halt=True` faulting-PC dump.

`recover_target` is the escape hatch when firmware has disabled SWD, slept the
core, or wedged it in a loop: it asserts reset *while* connecting to catch the
core before firmware runs, then (by default) mass-erases flash so the bad image
can't re-wedge the board. Close any open session on the device first — connect-
under-reset needs an exclusive, fresh connection.

## Sessions & RTT streaming

`read_firmware_log` is the quick, stateless way to grab RTT output (open probe,
poll for `timeout_s`, close). For continuous capture, use a **persistent
session**: a background thread drains the RTT up channel so you can read
accumulated output incrementally.

```python
sid = open_session(device_id=dev, target="stm32f303retx")["data"]["session_id"]
flash_firmware(device_id=dev, firmware_path="app.elf")  # routed through the session
start_rtt(session_id=sid)                                # RTT located from the ELF
# Deterministic checkpoint: block until the firmware says it's ready (or 5s).
wait_for_rtt(session_id=sid, pattern="SELF-TEST PASS", timeout_s=5.0)  # data.matched
read_rtt(session_id=sid)   # -> data.text has everything since the last read
stop_rtt(session_id=sid)
close_session(session_id=sid)
```

`wait_for_rtt` is the thin ergonomic helper that turns "flash and run" into a
verdict: branch on `data.matched` (true if the pattern was seen, false on
timeout). Set `regex=True` to match a regular expression.

While a session is open the plain tools (flash/reset/memory) automatically reuse
it, so the probe is never double-claimed.

## Install

```bash
# from the repo root
pip install -e servers/boardex-core
pip install -e servers/boardex-target
```

On Linux you also need udev rules so the probe is accessible without root:

```bash
# ST-Link / CMSIS-DAP access (one-time)
sudo pyocd pack --update   # optional: refresh target support packs
```

## Run

```bash
boardex-target          # runs over stdio, the transport MCP clients use
```

### Register it with an MCP client

```jsonc
{
  "mcpServers": {
    "boardex-target": { "command": "boardex-target" }
  }
}
```

## Notes for the STM32 Nucleo

- The onboard **ST-Link** is discovered automatically by `list_targets`.
- Pass the MCU part number as `target` (e.g. `"stm32f411re"` for a Nucleo-F411RE)
  when flashing — ST-Link cannot always auto-detect the die.
- Run `pyocd list --targets | grep stm32` to see built-in target names.

## Add a new probe backend

Backends are discovered as plugins — your adapter can live in its own
pip-installable package with zero changes to this one:

1. Implement `boardex_core.TargetController` (plus any opt-in capability
   protocols: `SupportsSessions`, `SupportsRttLocation`,
   `SupportsPeripheralInspection`).
2. Publish an entry point in your `pyproject.toml`:

```toml
[project.entry-points."boardex.target_backends"]
jlink = "boardex_jlink.adapter:JLinkAdapter"
```

3. Prove conformance with the shared suite
   (`boardex_core.testing.TargetControllerConformance`).

That's it — `pip install` your package and the backend appears in
`list_targets()`. No tool or agent changes. See
[`../CONTRIBUTING.md`](../CONTRIBUTING.md) and
[`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

[pyOCD]: https://pyocd.io
