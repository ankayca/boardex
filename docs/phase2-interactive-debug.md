# Phase 2 design note — interactive (halt-mode) debugging on `boardex-target`

Status: **proposed / not yet implemented.** This is the queued next phase for the
programmer side, written down now so the trio we just shipped (ELF symbol
resolution, exception-frame decode, `wait_for_rtt`) is understood as its
foundation.

## Why (and why it's a separate phase)

The shipped loop — build → flash → run → observe (RTT + `read_chip_status`) →
recover — covers "is it working?" and "did it crash, where?" **without stopping
the core**, which is what lets it compose with the free-running measurement side
(logic analyzer / scope). That non-intrusive model handles ~80% of firmware
bring-up.

The remaining ~20% needs the agent to *stop the core and look around*:

- bugs that manifest **before logging is up** (early clock/RAM/stack init);
- **memory corruption** ("who is writing this address?") — no `printf` can find
  a culprit you haven't identified yet;
- **Heisenbugs** where adding `rtt_write()` changes timing and hides the fault;
- **cheaper iteration** — inspect a variable at a breakpoint instead of an
  edit → build → flash → observe cycle that also pollutes firmware with debug
  code.

This is a genuinely different **execution model** (core stopped ⇒ no signals for
the instrument side), so it deserves its own deliberate surface rather than a
bolt-on. It also builds directly on Phase-1 primitives, so it's much cheaper to
add now than it would have been first.

## Design principles (unchanged from the architecture)

- **Coarse, verdict-returning tools**, never raw gdb micro-ops. The agent should
  call `run_until(symbol)` and get a full, source-mapped context dump back — not
  drive `step / continue / read_reg` in a loop (that's the "twenty register
  pokes" the architecture warns against and it makes LLM tool-selection flaky).
- **Server stays a dumb executor.** It reports where execution stopped and the
  machine state; the *agent* decides pass/fail. No test logic in the server.
- **All new capability lands on the brand-neutral `TargetController` ABC**, so a
  future J-Link/OpenOCD adapter inherits it. Vendor code stays in the adapter.
- **Session-scoped and lock-serialised.** Halt-mode debugging needs the probe
  held open and the core stopped, which is exactly what `ManagedSession` already
  provides (it holds the pyOCD session and serialises target access behind one
  lock). Breakpoints/watchpoints become session state, freed on `close_session`.

## Proposed `TargetController` additions

```python
def set_breakpoint(device_id, location, *, target=None) -> OperationResult
def clear_breakpoint(device_id, location, *, target=None) -> OperationResult
def set_watchpoint(device_id, address, *, size=4, access="write", target=None) -> OperationResult
def clear_watchpoint(device_id, address, *, target=None) -> OperationResult
def run_until(device_id, location=None, *, timeout_s=5.0, target=None) -> OperationResult
def step(device_id, *, count=1, over=True, target=None) -> OperationResult
def read_registers(device_id, *, target=None) -> OperationResult
def write_register(device_id, name, value, *, target=None) -> OperationResult
def backtrace(device_id, *, max_frames=16, target=None) -> OperationResult
```

- `location` accepts a **symbol name**, `file:line`, or a raw address. Resolution
  reuses the Phase-1 `ElfInfo` (`symbol_address`, and a new `line -> address`
  lookup — the DWARF line rows we already parse, inverted).
- Cortex-M has limited hardware resources (FPB breakpoints, DWT watchpoints,
  typically 6 and 4 on an M4). The adapter must track usage and return a clean
  `verdict="error"` ("no hardware breakpoint slots free") rather than silently
  failing — capacity is discoverable via a new `list_debug_resources`.

## Proposed MCP tools (Facade)

`set_breakpoint` / `clear_breakpoint`, `set_watchpoint` / `clear_watchpoint`,
`run_until`, `step`, `read_registers` / `write_register`, `backtrace`.

**The headline ergonomic tool is `run_until`:** set-if-needed + resume + wait,
returning on breakpoint hit (or timeout) a single dump:

```jsonc
{
  "verdict": "pass",                     // "fail" on timeout (agent branches on data)
  "summary": "Stopped at i2c_write (i2c.c:42).",
  "data": {
    "stopped": true, "reason": "breakpoint", "timed_out": false,
    "pc": 134218842, "location": "i2c_write (i2c.c:42)",
    "registers": { "r0": 0, "sp": 536891360, "lr": 134218321, "...": 0 },
    "backtrace": [
      {"pc": 134218842, "location": "i2c_write (i2c.c:42)"},
      {"pc": 134218510, "location": "sensor_read (sensor.c:88)"}
    ]
  }
}
```

`set_watchpoint(address, access="write")` + `run_until()` is the marquee
capability with no `printf` equivalent: catch the instruction that corrupts a
variable and report it as `func (file:line)`.

## Reuse from Phase 1

- **`ElfInfo`** — symbol/`file:line` ↔ address (add the inverse `line -> address`).
- **`cortex_m`** — exception-frame decode already recovers a fault frame;
  `backtrace` generalises stack unwinding (start simple: frame-pointer / stacked
  LR chain; DWARF CFI unwinding is a later refinement).
- **`ManagedSession`** — holds the probe and the lock; breakpoint/watchpoint
  tables live here and are torn down on close.

## Sequencing & risks

1. `read_registers` / `write_register` / `step` (smallest; validates halt-mode
   plumbing through the session).
2. `set_breakpoint` + `run_until` (the core loop).
3. `set_watchpoint` + `run_until` (the unique-value feature).
4. `backtrace` (start with the naive LR/FP walk; note low-confidence like the
   Phase-1 fault frame does).

**Risks:** limited HW breakpoint/watchpoint slots (track + report); reliable
resume/halt state across pyOCD (re)connections — Phase 1 already showed halt does
not persist across separate transient connects, so **all of this must run inside
one open `ManagedSession`**, never transient tool-to-tool composition; and the
halted-core-vs-live-measurement mode split must be documented so the agent
doesn't try to scope a stopped core.
