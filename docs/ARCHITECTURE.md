# Boardex Architecture

This document explains how Boardex is put together so that **any contributor can add
support for a new piece of lab equipment without touching the agent-facing code.**

If you only read one thing, read the "Layers" and "How to add a new backend"
sections below.

---

## The big picture

Boardex is a Cursor-style **Electron desktop app** whose agents close the full
hardware development loop:

```
 ┌─────────────────────────────────────────────────────────────┐
 │  Electron App (UI, chat, project files)   ← like Cursor      │
 └───────────────┬─────────────────────────────────────────────┘
                 │  spawns / talks to
 ┌───────────────▼─────────────────────────────────────────────┐
 │  Agent runtime (LLM + tool use)                              │
 └───────────────┬─────────────────────────────────────────────┘
                 │  MCP (Model Context Protocol) over stdio / network
   ┌─────────────┼───────────────────────────────┐
   │             │                                │
 ┌─▼──────────┐ ┌▼───────────────┐  ┌────────────▼────────────┐
 │boardex-    │ │ boardex-logic  │  │ boardex-scope (later)   │
 │target      │ │ (sigrok)       │  │ (SCPI / pyvisa)         │
 │(flash/debug│ │ logic analyzers│  │ oscilloscopes           │
 └─┬──────────┘ └─┬──────────────┘  └────────────┬────────────┘
   │ real USB     │ real USB                     │ real USB/LAN
 ┌─▼──────────┐ ┌─▼──────────────┐  ┌────────────▼────────────┐
 │ STM32      │ │ Saleae clone / │  │ Rigol / Siglent scope   │
 │ Nucleo     │ │ Kingst LA      │  │                         │
 └────────────┘ └────────────────┘  └─────────────────────────┘
```

**Key decision: one MCP server per *capability domain*, not per device model.**
- `boardex-target` — flash & debug any MCU target (ST-Link, J-Link, OpenOCD...).
- `boardex-logic` — capture & decode with any logic analyzer (Saleae clone, Kingst...).
- `boardex-scope` — configure & measure with any oscilloscope.

Within a domain, individual devices are just *parameters*, hidden behind an
adapter. This keeps agent tool-selection reliable and isolates faults: if a USB
device wedges, only its domain server is affected.

---

## Layers

Every Boardex MCP server is built from the same four layers. Dependencies point
**downward only** (Dependency Inversion): the server depends on abstractions in
`boardex-core`, never directly on a vendor SDK.

```
  Layer 4  MCP Tools (Facade)      server.py    → coarse, verdict-returning tools
  Layer 3  Registry (Factory)      registry.py  → discovers & owns backends
  Layer 2  Adapters (Adapter)      adapters/*   → wrap one vendor tool/SDK each
  Layer 1  Interfaces + Results    boardex-core → the contract everyone shares
```

### Layer 1 — `boardex-core` (the shared contract)
Pure Python, zero hardware dependencies. Contains:
- **`interfaces.py`** — abstract base classes such as `TargetController`. These are
  the *only* thing the upper layers are allowed to know about.
- **`results.py`** — `OperationResult` + `Verdict`. Every operation returns the
  same structured shape so agents can branch deterministically
  (`pass` / `fail` / `error` / `inconclusive`) instead of parsing prose.
- **`errors.py`** — a typed exception hierarchy (`DeviceNotFoundError`, ...).
- **`registry.py`** — the `BackendRegistry` (see Layer 3).

### Layer 2 — Adapters (the **Adapter pattern**)
Each adapter wraps exactly one vendor backend (e.g. `PyOcdAdapter` wraps pyOCD)
and implements a `boardex-core` interface. This is where all the messy,
vendor-specific USB code lives — quarantined behind a clean interface.

### Layer 3 — Registry (the **Registry + Factory patterns**)
`BackendRegistry` holds the available adapters, aggregates `scan()` across all of
them into a single bench inventory, and resolves a `device_id` back to the adapter
that owns it. It is the single source of truth for "what's on the bench".

### Layer 4 — MCP Tools (the **Facade pattern**)
`server.py` exposes a small number of **coarse-grained, intent-level tools**
(`flash_firmware`, `reset_target`, ...) built on [FastMCP]. Tools never talk to
hardware directly — they go through the registry to an adapter and return an
`OperationResult`.

---

## Design principles for agent-facing tools

These rules exist because tools are consumed by an LLM, not a human:

1. **Coarse over granular.** Prefer `flash_firmware(...)` over twenty register
   pokes. Fewer, higher-level tools = more reliable tool selection.
2. **Always return a `Verdict`.** The agent's flash→test→verify loop must be able
   to branch on a machine-readable outcome, never on free-form text.
3. **Fail loudly and typed.** Adapters raise `BoardexError` subclasses; the facade
   converts them into `verdict="error"` results with actionable summaries.
4. **Stateless where possible.** Open a session, do the op, close it. This avoids
   stuck/locked debug sessions — the #1 source of flaky benches.
5. **Every device has a stable `device_id`.** Agents address hardware by id, and
   the registry maps id → owning adapter.

---

## Persistent sessions (target server)

Most operations are stateless (open probe → do → close) to avoid stuck debug
sessions. But streaming firmware logs (RTT) needs the probe held open, so
`boardex-target` adds a session layer:

- **`SessionManager`** owns `ManagedSession`s, one per device, and is shared with
  the adapter. When a session is open, the stateless tools transparently route
  through it (the probe can only be claimed once).
- **`ManagedSession`** serialises all target access behind a single lock, and
  runs a **background RTT reader thread** that drains the up channel into a
  ring buffer for `read_rtt` to fetch incrementally.

Session lifecycle tools: `open_session` / `close_session` / `list_sessions` and
`start_rtt` / `read_rtt` / `stop_rtt`.

## How to add a new backend (the contributor workflow)

Say you want to add J-Link support to `boardex-target`:

1. Create `adapters/jlink_adapter.py` with `class JLinkAdapter(TargetController)`.
2. Implement the abstract methods (`scan`, `flash`, `reset`, ...) using the J-Link
   SDK. All vendor quirks stay inside this file.
3. Register it in `server.py`: `registry.register("jlink", JLinkAdapter)`.
4. Done. **No tool definitions change, no agent code changes.** The new probe just
   shows up in `list_targets()`.

To add a whole new *domain* (e.g. power supplies), create a new server package
that reuses `boardex-core` and follows the same four layers.

[FastMCP]: https://github.com/modelcontextprotocol/python-sdk
