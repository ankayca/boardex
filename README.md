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

## Status

Early stage — this README will be updated as the architecture, supported equipment list, and setup instructions are finalized.

## Supported equipment (planned)

- Debug probes: J-Link, ST-Link, OpenOCD-compatible
- Logic analyzers: Saleae, Digilent
- Oscilloscopes: Rigol, Siglent
- Power supplies / profilers: TBD

## Getting started

_Coming soon._

## License

TBD
