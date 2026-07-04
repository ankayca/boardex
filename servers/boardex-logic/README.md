# boardex-logic

MCP server that lets a Boardex agent **capture and decode digital signals** with
a logic analyzer. First backend: [sigrok] (`sigrok-cli`), which supports the
Kingst LA series (LA1010/LA1016/LA2016/LA5016/LA5032 via the `kingst-la2016`
driver), cheap FX2 clones (`fx2lafw`), and dozens of other analyzers. New
analyzers plug in without changing any tool.

## Tools exposed to the agent

| Tool | What it does |
|---|---|
| `list_analyzers` | Discover connected logic analyzers |
| `get_capabilities` | Channels, sample rates, and trigger types of one device |
| `capture` | Acquire samples; returns a compact per-channel edge list |
| `decode_bus` | Capture + decode a bus (I2C/SPI/UART/...) into transactions |

Every tool returns an `OperationResult` (`verdict`, `summary`, `data`, ...), so
the agent branches on a machine-readable outcome, never on prose.

## Measurements first, then compact transitions

An acquisition can be millions of samples wide, and an agent shouldn't have to do
physics on a raw array. So `capture` returns **per-channel measurements** the
agent branches on directly, plus a compact transition list for detail:

- `data.measurements[ch]` — `active` (did it toggle?), `edges`, `frequency_hz`
  (estimated fundamental), `duty_cycle` (0..1), `min_pulse_width_s` (surfaces
  glitches/runt pulses).
- `data.transitions[ch]` — `[[sample_index, level], ...]` (edges only), **clipped
  for size** on very busy channels; the exact counts live in `measurements`.
- `data.sample_rate_hz`, `data.num_samples`, `data.duration_s`.

The requested sample count is honored deterministically (streaming analyzers like
the LA1010 over-deliver; the extra is clamped) so a sample index maps to real
time.

```python
dev = list_analyzers()["data"]["devices"][0]["device_id"]
caps = get_capabilities(dev)["data"]           # pick a valid rate/channels
cap = capture(dev, channels=[0, 1], sample_rate_hz=10_000_000,
              num_samples=100_000, trigger_channel=0, trigger_edge="rising")
m = cap["data"]["measurements"]["CH0"]
if m["active"] and abs(m["frequency_hz"] - 1_000_000) < 1_000:
    ...                                         # clock is ~1 MHz as expected
```

## Decoding buses

`decode_bus` runs a libsigrokdecode protocol decoder over a fresh capture so the
agent can check a bus against a datasheet instead of eyeballing waveforms:

```python
decode_bus(dev, protocol="i2c", channel_map={"scl": 0, "sda": 1},
           sample_rate_hz=4_000_000, num_samples=200_000)
# -> data.annotations: [{"start":..., "end":..., "decoder":"i2c", "text":"START"}, ...]
decode_bus(dev, protocol="uart", channel_map={"rx": 0},
           options={"baudrate": "115200"}, duration_s=0.05)
```

Verdict is `inconclusive` if nothing decoded (wrong channel map, sample rate too
low, or an idle bus) rather than a hard failure.

## Install

```bash
# from the repo root
pip install -e servers/boardex-core
pip install -e servers/boardex-logic
```

This package shells out to a **system-installed `sigrok-cli`** (it is not a
Python dependency). `list_analyzers().data.backends` is empty until sigrok is on
`PATH`. Install it with your package manager, e.g. `apt install sigrok-cli`.

> **Kingst LA series caveat:** the `kingst-la2016` driver was added *after*
> libsigrok 0.5.2, so distro packages (e.g. Debian bookworm's `sigrok-cli`) are
> too old to drive Kingst devices — build libsigrok/sigrok-cli from git master.
> These analyzers also need a **vendor firmware + FPGA bitstream** uploaded on
> every plug-in; extract them from the KingstVIS software with
> `sigrok-fwextract-kingst-la2016` (from `sigrok-util`) and drop them in
> `~/.local/share/sigrok-firmware/`. Without the blobs `--scan` shows the device
> but capture fails. See [`docs/kingst-la-bringup.md`](../../docs/kingst-la-bringup.md).

## Run

```bash
boardex-logic          # runs over stdio, the transport MCP clients use
```

### Register it with an MCP client

```jsonc
{
  "mcpServers": {
    "boardex-logic": { "command": "boardex-logic" }
  }
}
```

## Add a new analyzer backend

1. Create `boardex_logic/adapters/<name>_adapter.py` implementing
   `boardex_core.LogicAnalyzer`.
2. `registry.register("<name>", YourAdapter)` in `server.py`.

That's it — no tool or agent changes. See [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

[sigrok]: https://sigrok.org
