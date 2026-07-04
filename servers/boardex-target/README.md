# boardex-target

MCP server that lets a Boardex agent **flash and debug MCU targets** over standard
debug probes. First backend: [pyOCD] (ST-Link, CMSIS-DAP). J-Link / OpenOCD /
STM32CubeProgrammer are future adapters that plug in without changing any tool.

## Tools exposed to the agent

| Tool | What it does |
|---|---|
| `list_targets` | Discover connected debug probes / MCU targets |
| `flash_firmware` | Program a `.elf`/`.hex`/`.bin` and reset |
| `reset_target` | Reset (optionally halt after reset) |
| `halt_target` / `resume_target` | Stop / start the CPU core |
| `read_memory` / `write_memory` | Peek/poke target memory (hex payloads) |
| `read_firmware_log` | One-shot: drain SEGGER RTT output for a timeout |
| `open_session` / `close_session` / `list_sessions` | Manage persistent debug sessions |
| `start_rtt` / `read_rtt` / `stop_rtt` | Background RTT streaming on an open session |

Every tool returns an `OperationResult` (`verdict`, `summary`, `data`, ...).

## Sessions & RTT streaming

`read_firmware_log` is the quick, stateless way to grab RTT output (open probe,
poll for `timeout_s`, close). For continuous capture, use a **persistent
session**: a background thread drains the RTT up channel so you can read
accumulated output incrementally.

```python
sid = open_session(device_id=dev, target="stm32f303retx")["data"]["session_id"]
flash_firmware(device_id=dev, firmware_path="app.elf")  # routed through the session
start_rtt(session_id=sid)
# ... let the firmware run ...
read_rtt(session_id=sid)   # -> data.text has everything since the last read
stop_rtt(session_id=sid)
close_session(session_id=sid)
```

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

1. Create `boardex_target/adapters/<name>_adapter.py` implementing
   `boardex_core.TargetController`.
2. `registry.register("<name>", YourAdapter)` in `server.py`.

That's it — no tool or agent changes. See [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

[pyOCD]: https://pyocd.io
