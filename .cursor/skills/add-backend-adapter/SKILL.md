---
name: add-backend-adapter
description: Add support for new lab hardware to Boardex — a new probe backend (J-Link, OpenOCD), logic analyzer, peripheral inspector for a silicon family, or a whole new domain server. Use when adding hardware/vendor/backend support under servers/ or writing a new adapter package.
---

# Adding hardware support to Boardex

Full reference: `servers/CONTRIBUTING.md` and the layering rules in
`.cursor/rules/boardex-server-conventions.mdc`. Read both before starting.
Adding hardware is a plugin-package job — **no edits to server.py or tools/**.

## Which of the three extension paths?

1. **New probe or analyzer brand** (J-Link, Saleae, ...) → backend adapter, below.
2. **New silicon family peripherals** (ESP32 I2C, NXP GPIO, ...) → peripheral
   inspector: in-tree module under `boardex_target/peripherals/` (see
   `stm32_i2c.py`) or a `boardex.peripheral_inspectors` entry point. Pure
   register maps + decoders; no vendor SDK.
3. **New capability domain** (scopes, PSUs, DMMs) → define the interface in
   `boardex-core` first, then a new `servers/boardex-<domain>/` package with
   `backends.py`, a `server.py` facade, and one adapter. Warning: `boardex-scope`
   territory overlaps the Deferred Register (programmable PSU control is
   explicitly cut from MVP) — confirm scope before building.

## Backend adapter checklist

An adapter wraps exactly one vendor SDK/tool and implements
`boardex_core.TargetController` or `boardex_core.LogicAnalyzer`.

1. **Implement the interface.** Reference implementations:
   `boardex_target/adapters/pyocd_adapter.py` (target),
   `boardex_logic/adapters/sigrok_adapter.py` (logic),
   `boardex_core.testing.FakeTargetController` (minimal in-memory).
2. **Follow the adapter rules:**
   - Every operation returns `OperationResult`; agents branch on `verdict`
     (`pass`/`fail`/`error`/`inconclusive`).
   - Raise typed `BoardexError` subclasses — never leak raw vendor exceptions.
   - Namespace device ids: `"<backend_name>:<stable-id>"`.
   - `scan()` never raises and returns `[]` when tooling is missing;
     `is_available()` reports whether the vendor dependency is installed.
   - Vendor SDK stays quarantined in the adapter package — nothing above
     Layer 2 imports it (no pyOCD/SDK imports in tools, registry, or core).
3. **Opt into capabilities** via runtime-checkable protocols in
   `boardex_core.capabilities` — never `getattr` duck-typing:
   - `SupportsSessions` → persistent sessions + background RTT
   - `SupportsRttLocation` → RTT control-block discovery from the ELF
   - `SupportsPeripheralInspection` → `inspect_peripheral` + on-failure evidence
4. **Publish the entry point** in the package's `pyproject.toml`:

```toml
[project.entry-points."boardex.target_backends"]   # or "boardex.logic_backends"
jlink = "boardex_jlink.adapter:JLinkAdapter"
```

   The registry passes shared server objects (e.g. `sessions`) only to factories
   declaring the matching keyword argument. A plugin that fails to import is
   logged and skipped — it cannot take the bench down.
5. **Prove conformance** (hardware-free, mandatory):

```python
from boardex_core.testing import TargetControllerConformance

class TestJLinkAdapter(TargetControllerConformance):
    def make_adapter(self):
        return JLinkAdapter()
```

   (`LogicAnalyzerConformance` for analyzers.)
6. **Verify:** `pip install -e` the new package into `.venv`, run the pytest
   suites (see the `pytest-servers` skill), and confirm the backend appears in
   `list_targets()` / `list_analyzers()`.

## Never

- Bake family-specific defaults into generic layers (no hardcoded `I2C1`).
- Add granular register-poke tools — tools are coarse and intent-level because
  an LLM calls them.
- Write tests that require hardware.
