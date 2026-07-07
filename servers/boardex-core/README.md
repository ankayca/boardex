# boardex-core

Shared foundation for every Boardex MCP server. **Zero hardware dependencies** —
just the contracts that keep the whole system decoupled.

## What's inside

| Module | Purpose | Pattern |
|---|---|---|
| `interfaces.py` | Abstract base classes (`TargetController`, `LogicAnalyzer`, `Backend`) + `DeviceInfo` | Dependency Inversion |
| `capabilities.py` | Opt-in adapter capabilities (`SupportsSessions`, `NativeSession`, ...) | runtime-checkable Protocols |
| `results.py` | `OperationResult` + `Verdict` — the uniform, agent-friendly return shape | — |
| `errors.py` | Typed exception hierarchy (`DeviceNotFoundError`, ...) | — |
| `registry.py` | `BackendRegistry` — owns backends, resolves `device_id` → adapter, and discovers third-party adapters via entry points (`load_plugins`) | Registry + Factory + Plugin |
| `facade.py` | Shared MCP-facade plumbing (`guard`, `list_devices_result`) | — |
| `evidence.py` | `EvidenceBundle` / `WorkflowStep` for composite workflows | — |
| `testing/` | Reference fakes + reusable adapter **conformance suites** | — |

Upper layers depend **only** on these abstractions, never on a vendor SDK. That's
what lets a contributor add a new probe or instrument by writing a single adapter
package — see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

See [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for the full design.

## Develop

```bash
pip install -e ".[dev]"
pytest
```

The tests use an in-memory fake backend, so they run with no bench attached.
