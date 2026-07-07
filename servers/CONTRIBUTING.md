# Contributing to the Boardex servers

Boardex aims to work with **any lab equipment — every brand and model**. The
server stack is built so that supporting a new device is a self-contained,
one-package job: you write an adapter, publish an entry point, and it appears
on the bench. This guide covers the three ways to extend the stack.

## Layout

```
servers/
  boardex-core/     shared contract: interfaces, results, errors, registry,
                    capability protocols, plugin loading, test kit
  boardex-target/   MCP server: flash & debug MCU targets (pyOCD built in)
  boardex-logic/    MCP server: logic analyzers (sigrok built in)
```

Layering (dependencies point downward only):

```
Layer 4  MCP Tools (Facade)    server.py + tools/*  → coarse, verdict-returning tools
Layer 3  Registry (Factory)    boardex_core.registry → discovers & owns backends
Layer 2  Adapters (Adapter)    adapters/* or your own package → one vendor SDK each
Layer 1  Interfaces + Results  boardex-core → the shared contract
```

## Dev setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e "servers/boardex-core[dev]"
pip install -e "servers/boardex-target[dev]"
pip install -e "servers/boardex-logic[dev]"
pytest servers/boardex-core/tests servers/boardex-target/tests servers/boardex-logic/tests
```

All tests are hardware-free and must stay that way.

## 1. Add a backend adapter (new probe / analyzer brand)

An adapter wraps exactly one vendor SDK/tool and implements the domain
interface from `boardex_core` (`TargetController` or `LogicAnalyzer`).

### Rules every adapter must follow

1. **Return `OperationResult`** from every operation; agents branch on the
   machine-readable `verdict` (`pass`/`fail`/`error`/`inconclusive`).
2. **Raise typed errors** (`BoardexError` subclasses) — never leak raw vendor
   exceptions across the facade boundary.
3. **Namespace your device ids**: `"<backend_name>:<stable-id>"`.
4. **`scan()` never raises** and returns `[]` when your tooling is missing
   (`is_available()` reports whether the vendor dependency is installed).
5. **Keep the vendor SDK quarantined** in your adapter package; nothing above
   Layer 2 may import it.

### Opt-in capabilities

Implement any of the runtime-checkable protocols in
`boardex_core.capabilities` to unlock extra behavior — no server changes:

| Protocol | Unlocks |
|---|---|
| `SupportsSessions` (`probe_unique_id`, `open_native_session`) | persistent sessions + background RTT streaming |
| `SupportsRttLocation` (`rtt_control_block`) | automatic RTT control-block discovery from the ELF |
| `SupportsPeripheralInspection` (`inspect_peripheral`) | the `inspect_peripheral` tool and on-failure evidence |

`open_native_session` returns an object satisfying the `NativeSession`
protocol (`run`, `open_rtt`, `close`). Serialise device access internally —
one probe is rarely thread-safe. Raise `RttUnavailableError` from `open_rtt`
when the firmware has no RTT; the session layer turns it into an
`inconclusive` result. See `PyOcdNativeSession` in
`boardex_target/adapters/pyocd_adapter.py` for the reference implementation,
and `boardex_core.testing.FakeTargetController` for a minimal in-memory one.

### Publish it as a plugin

In your package's `pyproject.toml`:

```toml
[project.entry-points."boardex.target_backends"]   # or "boardex.logic_backends"
jlink = "boardex_jlink.adapter:JLinkAdapter"
```

That's the whole integration: `pip install` your package and the backend shows
up in `list_targets()` / `list_analyzers()`. The registry passes shared server
objects (e.g. `sessions`) only to factories that declare the matching keyword
argument, and a plugin that fails to import is logged and skipped — it cannot
take the bench down.

### Prove conformance

Subclass the suite for your domain and you get the contract checks for free:

```python
from boardex_core.testing import TargetControllerConformance

class TestJLinkAdapter(TargetControllerConformance):
    def make_adapter(self):
        return JLinkAdapter()
```

(`LogicAnalyzerConformance` for analyzers.) The suites are hardware-free; the
built-in pyOCD and sigrok adapters pass them, and yours must too.

## 2. Add a peripheral inspector (new silicon family)

Peripheral inspectors are pure register maps + decoders, keyed by silicon
family and name (`"stm32:I2C1"`); bare names resolve when unambiguous.

- **In-tree:** add a module under `boardex_target/peripherals/` and register
  your inspectors (see `stm32_i2c.py`).
- **Third-party:** publish an entry point in `boardex.peripheral_inspectors`
  whose callable returns an iterable of inspectors.

An inspector implements `memory_reads()` (which register blocks to fetch) and
`decode(blocks)` (raw bytes → registers/pins/clocks/hints). No vendor SDK is
involved — the adapter does the actual memory reads.

## 3. Add a new domain server (scopes, PSUs, DMMs, ...)

A new capability domain is a new package reusing `boardex-core`:

1. Define the domain interface in `boardex-core` (like `LogicAnalyzer`).
2. Create `servers/boardex-<domain>/` with a `backends.py` (`build_registry()`
   + a `boardex.<domain>_backends` entry-point group), a `server.py` facade,
   and at least one adapter.
3. Keep tools **coarse and intent-level** — an LLM calls them. One tool per
   engineer intention ("capture this bus"), not per SDK function.

## Conventions recap

- Coarse tools; every tool returns an `OperationResult` dict.
- Stateless where possible (sessions/RTT are the deliberate exception).
- Fault isolation everywhere: one broken backend/plugin never kills the rest.
- New tests must run without hardware.
