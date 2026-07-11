---
name: pytest-servers
description: Set up the Python venv and run the Boardex server test suites (boardex-core, boardex-target, boardex-logic). Use when changing anything under servers/, when asked to run server tests, or when pytest/imports fail for the Python packages.
---

# Running the Boardex server tests

The npm workspace (`npm run verify`) does NOT cover `servers/` — it is Python-land.
Server changes are verified with pytest only.

## Environment

The repo venv lives at `.venv/` in the workspace root. Bootstrap (idempotent):

```bash
cd /home/ankayca/boardex
python -m venv .venv                      # only if .venv is missing
source .venv/bin/activate
pip install -e "servers/boardex-core[dev]"
pip install -e "servers/boardex-target[dev]"
pip install -e "servers/boardex-logic[dev]"
```

The editable installs matter: `boardex-target` and `boardex-logic` depend on
`boardex-core`, and the MCP entry points in `.cursor/mcp.json` point at
`.venv/bin/boardex-target` / `.venv/bin/boardex-logic`.

## Run tests

Full suite (what must be green before any commit touching `servers/`):

```bash
pytest servers/boardex-core/tests servers/boardex-target/tests servers/boardex-logic/tests
```

Targeted, when the change is scoped:

```bash
pytest servers/boardex-target/tests/test_session.py -q
pytest servers/boardex-core/tests -q -k registry
```

Changing `boardex-core` requires running all three suites — the other two
packages consume its interfaces, results, and conformance kit.

## Invariants

- **All tests are hardware-free and must stay that way.** Never write a test that
  needs a USB probe or analyzer attached. Use `boardex_core.testing` fakes
  (`FakeTargetController`, etc.) and the conformance suites.
- New adapters prove conformance by subclassing
  `boardex_core.testing.TargetControllerConformance` or `LogicAnalyzerConformance`.
- Never run `npm run lint` / eslint to "fix" server code — eslint ignores
  `servers/**` by design and the npm scaffold is the UI owner's territory.
