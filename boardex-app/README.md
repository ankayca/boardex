# boardex

Boardex in one command. `boardex up` launches the runner with the dashboard embedded and
serves both from a single origin; `boardex up --demo` replays a recorded bring-up run that
needs no hardware and no API key; `boardex doctor` reports what this machine is missing,
with the fix for each item.

```bash
pipx install boardex     # available after the first release
boardex up --demo
```

**Full documentation:**

- [Getting Started](https://github.com/ankayca/boardex/blob/main/docs/GETTING_STARTED.md)
  — install (including the pre-release form), the demo, your first run, adding hardware,
  troubleshooting.
- [Project README](https://github.com/ankayca/boardex/blob/main/README.md) — what Boardex
  is, and how to work from a checkout.

This package is a launcher. The work is done by four sibling packages — `boardex-core`,
`boardex-logic`, `boardex-target`, `boardex-runner[agent]` — which release in lockstep with
it. They resolve as `==<version>` pins by default (the publishable form); set
`BOARDEX_LOCAL_SIBLINGS=1` to resolve them against a checkout's `servers/` tree instead,
which is what the from-source install needs.
