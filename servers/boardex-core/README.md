# boardex-core

Shared foundation for every Boardex MCP server. **Zero hardware dependencies** —
just the contracts that keep the whole system decoupled.

## What's inside

| Module | Purpose | Pattern |
|---|---|---|
| `interfaces.py` | Abstract base classes (`TargetController`, `Backend`) + `DeviceInfo` | Dependency Inversion |
| `results.py` | `OperationResult` + `Verdict` — the uniform, agent-friendly return shape | — |
| `errors.py` | Typed exception hierarchy (`DeviceNotFoundError`, ...) | — |
| `registry.py` | `BackendRegistry` — discovers/owns backends, resolves `device_id` → adapter | Registry + Factory |

Upper layers depend **only** on these abstractions, never on a vendor SDK. That's
what lets a contributor add a new probe or instrument by writing a single adapter.

See [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for the full design.

## Develop

```bash
pip install -e ".[dev]"
pytest
```

The tests use an in-memory fake backend, so they run with no bench attached.
