# Boardex

[![CI](https://github.com/ankayca/boardex/actions/workflows/ci.yml/badge.svg)](https://github.com/ankayca/boardex/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/boardex)](https://pypi.org/project/boardex/)

**Early, open source (Apache-2.0), and built for contribution — the fastest way to help is to run it, then bring your hardware.**

Boardex is an AI agent that brings up firmware on real hardware — it plans the work,
writes and builds the code, flashes the board, drives a logic analyzer, and reads the
results back. It proves what it claims: every check links to a recorded artifact (logic
captures and protocol decodes, register and memory readbacks, serial logs), and every
action that touches the board waits behind an approval gate you control.

![The Boardex run workspace: streaming build logs on the left, a flash approval card waiting on the right](docs/images/run-workspace-approval.png)

## Install

```bash
pipx install boardex
```

Then start it — one command, and the dashboard opens with the tour on offer:

```bash
boardex up           # runner + dashboard at http://127.0.0.1:4380
```

The first screen you land on offers **Watch a demo run** alongside starting a real one,
so you can see the whole loop before plugging anything in. To jump straight there —
handy for a shared link — skip the click:

```bash
boardex up --demo    # opens on the demo: a recorded run replayed in your browser
```

Both print the URL and stop on Ctrl-C.

- **No hardware needed for the demo.** The demo replays a recorded bring-up end to end —
  plan, approval gate, live logs, a failed measurement, the diagnosis, the fix, the
  report. It touches no hardware, calls no model, and needs no API key.
- **Keys go in the dashboard, never the terminal.** Paste your model-provider key into
  Settings → Model provider in the page that opens. The runner holds it for the session,
  write-only — nothing is written to disk and no route ever serves a key back.
- **Everything is recorded and replayable.** A run is an append-only event stream plus
  its artifacts. The validation report exports as Markdown you can attach to a PR, and
  every check in it deep-links to the capture it came from.

## Docs

- **[Getting Started](docs/GETTING_STARTED.md)** — install, the demo, your first run,
  adding hardware, troubleshooting.
- **[OS support and bench setup](docs/SUPPORT_MATRIX.md)** — what runs where, and how
  probe/analyzer access works per platform. For Kingst logic analyzers, the one-time
  [bring-up](docs/kingst-la-bringup.md).
- **[Contributing](CONTRIBUTING.md)** — the design is in
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); adding an instrument is a one-file job.
  What we need most right now is in [Help build it](#help-build-it).

## Where this is today

Early software. The loop has been run end to end on STM32 Nucleo-F303RE benches with
BMP180/BME280-class I2C sensors, an ST-Link probe, and a Kingst logic analyzer. Linux and
WSL are the primary platforms; macOS and Windows run the software fine, but hardware
access there is less exercised. Expect rough edges, and please report them.

## Help build it

Boardex is built so that supporting new lab equipment never touches agent code: each
instrument domain is an MCP server assembled from the same four layers, and a new device
is one adapter file that implements a `boardex-core` interface plus a one-line
registration. The walkthrough is the "How to add a new backend" section of
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

What we want most, in order:

1. **Instrument adapters.** Debug probes first — J-Link and OpenOCD-compatible probes
   are both still "planned" rows in the [equipment table](#supported-equipment) — and
   logic analyzers beyond fx2lafw and Kingst. The flagship contribution is the **first
   oscilloscope adapter**: `boardex-scope` has its seat designed into the architecture
   (same four layers, SCPI/pyvisa backend, `"oscilloscope"` is already a device kind in
   `boardex-core`) but the code is unwritten — whoever ships it defines the domain.
   Start from [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
2. **Board bring-ups on new MCU families.** Run the loop on hardware we don't own and
   tell us what was weird — ideally with a recording attached (`RECORD=<dir> boardex up`,
   see [Getting Started](docs/GETTING_STARTED.md)) so we can replay your bench without
   owning your bench.
3. **Windows-native and macOS bench testing.** The software layer is CI-proven on all
   three OSes; hardware access off Linux needs more eyes. Start from the
   [OS support matrix](docs/SUPPORT_MATRIX.md) and the
   [Windows sigrok bring-up](docs/windows-sigrok-bringup.md).
4. **Confusion reports.** The moment you stopped being sure what was happening is a
   first-class report here, not a lesser one — file it with the
   ["I got confused" issue template](.github/ISSUE_TEMPLATE/confusion_report.yml).
   Nothing has to be broken for it to be worth filing.

Ground rules and setup live in [CONTRIBUTING.md](CONTRIBUTING.md); starter tasks are
labeled [good first issue](https://github.com/ankayca/boardex/labels/good%20first%20issue).

---

# Development

## How it's built

The agent reaches real hardware through **MCP (Model Context Protocol) servers — one per
capability domain**, not one per device model:

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
├── boardex-app/                  # the `boardex` CLI (up / doctor), bundles the built UI
├── servers/
│   ├── boardex-core/             # shared interfaces, results, errors, registry
│   ├── boardex-target/           # MCP server: flash/debug (pyOCD backend)
│   ├── boardex-logic/            # MCP server: capture/decode (sigrok backend)
│   └── boardex-runner/           # orchestrator: agent loop + the event stream
├── packages/contract/            # the wire contract (Zod schemas → TS types + JSON Schema)
├── apps/ui/                      # the dashboard (React)
├── tools/mock-runner/            # fixture replay for UI development
└── examples/
    └── firmware/                 # minimal reference firmware to validate the tooling
        ├── blinky-f303re/        #   bare-metal flash smoke test
        └── rtt-f303re/           #   RTT logging demo (read_firmware_log)
```

> **This repo is the Boardex tooling, not a firmware archive.** Only tiny,
> clean-room reference firmware lives in `examples/firmware/` to prove the
> servers work on real silicon. Your real per-board firmware belongs in its own
> project and is handed to the agent by absolute path. A top-level `firmware/`
> directory is git-ignored as a scratch area for local work.

## Supported equipment

| Domain | Device | Status |
|---|---|---|
| Debug probe | STM32 Nucleo (onboard ST-Link) | ✅ via `boardex-target` (pyOCD) |
| Debug probe | J-Link, OpenOCD-compatible | planned (adapter) |
| Logic analyzer | Cheap Saleae clone (FX2) | ✅ via `boardex-logic` (sigrok `fx2lafw`) |
| Logic analyzer | Kingst LA2016/LA1016/LA5016/LA5032 | ✅ via `boardex-logic` (sigrok `kingst-la2016`) — needs recent libsigrok + extracted firmware |
| Logic analyzer | Kingst LA1010 | ⚠️ via `boardex-logic` — mainline sigrok lists it untested (streaming-only); [bring-up](docs/kingst-la-bringup.md) |
| Oscilloscope | Rigol, Siglent | planned via SCPI/pyvisa |

*Every "planned" row is an open invitation — one adapter file. See
[Help build it](#help-build-it).*

## Working from a checkout

```bash
# Python side — the four server packages, editable
pip install -e "servers/boardex-core[dev]" -e "servers/boardex-logic[dev]" \
            -e "servers/boardex-target[dev]" -e "servers/boardex-runner[dev,agent]"

# Node side — UI, contract, mock runner
npm install
npm run verify        # typecheck + lint + test across workspaces

# the CLI itself, against the tree you just built
npm run build -w apps/ui
BOARDEX_SKIP_UI_BUILD=1 pip install -e "./boardex-app[dev]"
```

`npm run dev` runs the UI and the mock runner together — the fixture-replay setup the UI
is developed against, no Python and no hardware required.

Running an MCP server directly (stdio transport), e.g. to register it with another MCP
client:

```bash
boardex-target        # flash/debug
boardex-logic         # logic analyzers (needs a system sigrok-cli on PATH)
```

See [`servers/boardex-target/README.md`](servers/boardex-target/README.md) for Nucleo
specifics (target names, udev) and how to register the server with an MCP client.

## Contributing

Adding hardware is intentionally a one-file job: implement the relevant
`boardex-core` interface as an adapter and register it. See the "How to add a new
backend" section of [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), the ranked
wishlist in [Help build it](#help-build-it), and the ground rules in
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).
