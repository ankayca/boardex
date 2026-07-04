# Reference firmware

Minimal, clean-room firmware used to **validate the Boardex tooling** on real
hardware and to show contributors how to exercise the MCP servers.

**This is not where product/board firmware goes.** Boardex is an agent tooling
project, not a firmware archive. Real per-board firmware for agent tasks lives in
its own project and is handed to the agent by absolute path when flashing. For
local scratch work, use the git-ignored top-level `firmware/` directory.

| Demo | Purpose |
|---|---|
| `blinky-f303re` | Bare-metal LED blink — validates `flash_firmware` end-to-end |
| `rtt-f303re` | Blink + SEGGER RTT counter — validates `read_firmware_log` |

Each builds with a local `arm-none-eabi` toolchain (`make`); build outputs
(`*.elf`/`*.bin`) are git-ignored.
