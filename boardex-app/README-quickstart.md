# Boardex — quickstart

Agentic hardware bring-up on your own bench. One install, one command.

## Install

First, `pipx` itself.

```bash
sudo apt install pipx && pipx ensurepath      # Debian / Ubuntu
brew install pipx && pipx ensurepath          # macOS
```

Use your package manager's pipx, not pip's. On Ubuntu 23.04+ and Debian 12+,
`pip install --user pipx` stops with `error: externally-managed-environment`
(PEP 668) — the system Python refuses installs outside a venv, and that refusal
is the first thing a new machine hits.

### From an index — the canonical install (available after the first release)

```bash
pipx install boardex
```

Nothing is compiled at install time and **no Node is needed**: the published
wheel carries the UI already built, and the runner serves it from the same origin
it serves the API on.

This is the install to reach for the moment `boardex` and its four
`boardex-*` server packages are published. Until that day the index has none of
them, and the two paths below are the ones that work.

### From git — works today, and it needs Node 20+

```bash
BOARDEX_LOCAL_SIBLINGS=1 pipx install "git+ssh://git@github.com/ankayca/boardex.git#subdirectory=boardex-app"
```

pip clones the whole repo into a temp directory and builds `boardex-app` there,
so the build hook builds the UI too: `npm ci` at the repo root (that clone has no
`node_modules`), then `npm run build -w apps/ui`. Node 20+ and `npm` on `PATH`
are therefore required; without them the build refuses and says so.

`BOARDEX_LOCAL_SIBLINGS=1` is what points the four server requirements at the
clone pip already made, instead of at an index that does not carry them yet (see
"Where the dependencies come from"). Without it this install stops at
`No matching distribution found for boardex-core==0.1.0`.

### The wheel

```bash
python -m build boardex-app                    # → boardex-app/dist/boardex-0.1.0*.whl
pipx install ./boardex-app/dist/boardex-0.1.0-py3-none-any.whl
```

The wheel is self-contained in everything except the four server packages: it
needs no Node and compiles nothing, but its `boardex-core==0.1.0` … requirements
have to resolve somewhere — an index once they are published, or an environment
that already has them (a dev checkout, "Developing on it" below). It is a
publishable artifact, not yet a standalone installer.

## Run

```bash
boardex doctor     # what this machine has and what it is missing (advisory)
boardex up         # starts the runner, serves the UI, opens the browser
```

`boardex up` prints the URL (default <http://127.0.0.1:4380>) and stops on Ctrl-C.
If no browser opens — a headless box, an SSH session, a WSL install with nothing
on the Windows side — it says so and leaves you the URL to open yourself.

**No hardware? No API key? Take the tour:**

```bash
boardex up --demo
```

That opens `/demo` — a recorded agent run replayed entirely in the browser
(plan → approval gate → live logs → checks → diagnosis → fix iteration →
report). It touches no hardware, calls no model, and needs no key. Behind it the
runner runs its fake bench, so leaving the demo lands you in a working app
rather than on an agent bench with nothing configured.

## What you need for a real run

`boardex doctor` checks each of these and prints the fix command for whatever is
missing. Nothing it reports blocks `boardex up`; it always exits 0.

| Item | Needed for |
| --- | --- |
| Python ≥ 3.10 | everything |
| pyOCD (installed with Boardex) | flashing/debugging a target |
| `sigrok-cli` | logic-analyzer capture and protocol decode |
| `arm-none-eabi-gcc` | building the firmware under test |
| USB access (udev rules on Linux) | reaching the probe without root |
| A model provider API key | agent runs (see below) |

### The API key — no shell required

`boardex up`, then **Settings → Model provider** in the page that opens: paste
the key, Save. The runner holds it for the session (write-only — no route serves
a key back, so only the last few characters are ever shown again) and it takes
effect on the next run, no restart. Nothing is stored in the browser and nothing
is written to disk.

Exporting the provider-standard variable before launch still works and boots the
runner already configured — the dashboard then shows it as configured rather
than offering to set what is already set:

```bash
export OPENROUTER_API_KEY=...   # or ANTHROPIC_API_KEY, … — the fallback path
boardex up
```

Because the store lives in the runner process, a key set in the dashboard is
gone when you stop `boardex up`; an exported one is back on every launch. And
the credential routes require a loopback `Host`, so set keys from the machine
running the runner — with `--host 0.0.0.0`, a browser on another machine can use
everything else but cannot set a key.

## Commands

| Command | What it does |
| --- | --- |
| `boardex up` | runner (agent bench) + embedded UI, browser opens at `/` |
| `boardex up --demo` | same, fake bench, browser opens at `/demo` |
| `boardex up --no-open` | do not open a browser (headless boxes, SSH) |
| `boardex up --port N --host H` | bind somewhere else (default `127.0.0.1:4380`) |
| `boardex up --bench {agent,fake,real}` | override the bench (`real` needs `BOARDEX_BENCH_CONFIG`) |
| `boardex doctor` | host check with per-item fix commands |
| `boardex --version` | version |

Everything the runner already reads from the environment still applies —
`AGENT_MODELS`, `AGENT_MAX_TURNS`, `BOARDEX_BOARD_PROFILES`, `BOARDEX_BENCH_CONFIG`,
`RECORD` — `boardex up` only sets `HOST`, `PORT`, `BENCH` and `BOARDEX_SERVE_UI`.
A `BOARDEX_SERVE_UI` you set yourself wins, so you can point the runner at your
own UI build.

## Where the dependencies come from

`boardex` is a launcher; the work is done by four packages in this repo —
`boardex-core`, `boardex-logic`, `boardex-target`, `boardex-runner[agent]`. None
of them is on PyPI yet, so the build decides how to name them (`hatch_build.py`):

- **By default** — `==0.1.0` pins, the version in `servers/VERSION` (the four
  release in lockstep). This is the only form that means anything on a machine
  that does not have this repo, so it is what every built sdist and wheel
  carries.
- **Under `BOARDEX_LOCAL_SIBLINGS=1`** — local path requirements into the
  checkout's `servers/`, when all four are there. That is the from-source
  install: `pip install ./boardex-app` and the `git+ssh://…` form above, where
  pip clones the whole repo before building this subdirectory.

The default is the publishable one deliberately. A `file://` requirement baked
into an sdist's `PKG-INFO` is not advisory — hatchling reads that static
metadata instead of re-running the hook, so it reappears in every wheel built
from that sdist, and `python -m build` used to emit a matching pair of artifacts
that installed only on the machine that built them. `boardex-app/tests` asserts
the built metadata is free of path references.

Publishing `boardex` still requires publishing the four server packages
alongside it; the pins are then exactly the right metadata, and
`pipx install boardex` is the whole install.

A developer's `pip install -e ./boardex-app` needs no flag: the four are already
installed (editable, below), and pip resolves a pin against what is installed
without ever asking an index.

## Developing on it

```bash
pip install -e "servers/boardex-core[dev]" -e "servers/boardex-logic[dev]" \
            -e "servers/boardex-target[dev]" -e "servers/boardex-runner[dev,agent]"
npm run build -w apps/ui                    # VITE_RUNNER_URL="" for a same-origin bundle
BOARDEX_SKIP_UI_BUILD=1 pip install -e "./boardex-app[dev]"
pytest boardex-app/tests
```

The `[dev]` extra is pytest plus `hatchling` — the packaging tests render this
project's real metadata through the real build backend rather than a stand-in.

Building the wheel that "Install" starts from:

```bash
python -m build --wheel boardex-app         # → boardex-app/dist/boardex-*.whl
```

The build hook does the UI for you unless `BOARDEX_SKIP_UI_BUILD=1` is set: `npm
ci` at the repo root **when there is no `node_modules` yet** (an existing one is
left alone — `npm ci` would delete and reinstall it), then `npm run build -w
apps/ui`. It copies `apps/ui/dist`, the emitted contract schemas, and the probe
udev rules into `boardex_app/_bundled/` (git-ignored, re-included in the wheel by
hatch's `artifacts`). The UI is built with `VITE_RUNNER_URL=""` so its runner
base is relative — that is what makes the single-origin serve work.
