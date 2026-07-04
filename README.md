# Boardex

**An AI agent environment for hardware engineers.**

Boardex is a Cursor-style workspace for embedded and electronics engineers. Instead of just generating code, Boardex agents close the entire hardware development loop: write firmware, flash it to a target board, drive real lab equipment to validate it, read back the results, and iterate — automatically.

## Why

Hardware development is slow not because writing code is hard, but because every change has to survive contact with real silicon: flash, power up, probe, measure, compare against spec, debug, repeat. That loop is manual, repetitive, and eats most of an engineer's day.

Boardex automates the loop while keeping the engineer in control of the parts that actually require judgment — architecture decisions, tradeoffs, and final sign-off.

## What it does

- **Writes and edits firmware/embedded code** with full project context (datasheets, schematics, pinouts, register maps).
- **Flashes target boards** over standard debug interfaces (JTAG/SWD via J-Link, ST-Link, OpenOCD, etc.).
- **Drives lab equipment programmatically** using vendor Python/SCPI libraries — oscilloscopes, logic analyzers, power supplies, multimeters, function generators.
- **Captures and interprets results** — pulls waveforms and protocol decodes, checks them against expected behavior or spec, and flags timing violations, signal integrity issues, or protocol errors.
- **Iterates autonomously** — on failure, the agent proposes a fix, re-flashes, re-tests, and re-measures until the test passes or it needs human input.

## Typical loop

1. Engineer describes the goal or spec ("implement I2C driver for sensor X, verify timing against datasheet").
2. Agent writes the code.
3. Agent flashes the board.
4. Agent runs the test using connected lab equipment.
5. Agent reads the oscilloscope/logic analyzer output and checks against the spec.
6. If it fails, the agent debugs and repeats from step 2.
7. Engineer reviews and approves the final result.

## How it's built

Boardex is a **Cursor-style Electron app**. The agent reaches real hardware
through **MCP (Model Context Protocol) servers — one per capability domain**, not
one per device model:

- **`boardex-target`** — flash & debug any MCU (ST-Link, J-Link, OpenOCD, ...).
- **`boardex-logic`** — capture & decode with any logic analyzer (sigrok).
- **`boardex-scope`** — configure & measure with any oscilloscope *(planned)*.

Every server shares `boardex-core` and follows the same layered design
(Interfaces → Adapters → Registry → MCP tools). This means **you can add a new
instrument by writing a single adapter — no agent code changes.** Read the full
design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Repository layout

```
boardex/
├── docs/ARCHITECTURE.md          # the design, in one page
├── servers/
│   ├── boardex-core/             # shared interfaces, results, errors, registry
│   ├── boardex-target/           # MCP server: flash/debug (pyOCD backend)
│   └── boardex-logic/            # MCP server: capture/decode (sigrok backend)
├── examples/
│   └── firmware/                 # minimal reference firmware to validate the tooling
│       ├── blinky-f303re/        #   bare-metal flash smoke test
│       └── rtt-f303re/           #   RTT logging demo (read_firmware_log)
└── app/                          # Electron app (planned)
```

> **This repo is the Boardex tooling, not a firmware archive.** Only tiny,
> clean-room reference firmware lives in `examples/firmware/` to prove the
> servers work on real silicon. Your real per-board firmware belongs in its own
> project and is handed to the agent by absolute path. A top-level `firmware/`
> directory is git-ignored as a scratch area for local work.

## Status

Early stage. Working today:

- `boardex-core` + `boardex-target` — a loop-complete flash/debug server for an
  STM32 Nucleo (via its onboard ST-Link): build external firmware, flash it,
  stream RTT logs, decode crashes from the Cortex-M fault registers, and recover
  a wedged board with connect-under-reset + mass-erase.
- `boardex-logic` — a logic-analyzer server over sigrok: discover analyzers,
  report capabilities, capture channels as compact per-channel transition lists,
  and decode buses (I2C/SPI/UART/...). Validated end-to-end against sigrok's
  `demo` device; Kingst LA hardware needs a one-time [bring-up](docs/kingst-la-bringup.md)
  (recent libsigrok + extracted firmware).

## Supported equipment

| Domain | Device | Status |
|---|---|---|
| Debug probe | STM32 Nucleo (onboard ST-Link) | ✅ via `boardex-target` (pyOCD) |
| Debug probe | J-Link, OpenOCD-compatible | planned (adapter) |
| Logic analyzer | Cheap Saleae clone (FX2) | ✅ via `boardex-logic` (sigrok `fx2lafw`) |
| Logic analyzer | Kingst LA2016/LA1016/LA5016/LA5032 | ✅ via `boardex-logic` (sigrok `kingst-la2016`) — needs recent libsigrok + extracted firmware |
| Logic analyzer | Kingst LA1010 | ⚠️ via `boardex-logic` — mainline sigrok lists it untested (streaming-only); [bring-up](docs/kingst-la-bringup.md) |
| Oscilloscope | Rigol, Siglent | planned via SCPI/pyvisa |

## Getting started

```bash
# 1. install the shared core + a server (editable)
pip install -e servers/boardex-core
pip install -e servers/boardex-target   # flash/debug (pyOCD)
pip install -e servers/boardex-logic    # logic analyzers (sigrok)

# 2. plug in your STM32 Nucleo and list it
python -c "from boardex_target.server import registry; print(registry.scan())"

# 3. run an MCP server (stdio transport)
boardex-target
# ...or the logic-analyzer server (needs a system sigrok-cli on PATH)
boardex-logic
```

See [`servers/boardex-target/README.md`](servers/boardex-target/README.md) for
Nucleo specifics (target names, udev) and how to register the server with an MCP
client.

## Contributing

Adding hardware is intentionally a one-file job: implement the relevant
`boardex-core` interface as an adapter and register it. See the "How to add a new
backend" section of [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## License

TBD
