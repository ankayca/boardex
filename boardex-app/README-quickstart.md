# Boardex — quickstart

Agentic hardware bring-up on your own bench. One install, one command.

## Install and run

```bash
pipx install "git+ssh://git@github.com/ankayca/boardex.git#subdirectory=boardex-app"
boardex doctor     # what this machine has and what it is missing (advisory)
boardex up         # starts the runner, serves the UI, opens the browser
```

`boardex up` prints the URL (default <http://127.0.0.1:4380>) and stops on Ctrl-C.
No Node is needed: the wheel carries the built UI, and the runner serves it from
the same origin it serves the API on.

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
| A model provider API key | agent runs (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, …) |

The key is read from the environment by the runner at call time and is never
stored or logged. Export it before `boardex up`:

```bash
export OPENROUTER_API_KEY=...
boardex up
```

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
of them is on PyPI, so the build resolves them itself (`hatch_build.py`):

- **Inside a checkout of the monorepo** — which is what pip has in hand for both
  `pip install ./boardex-app` and the `git+ssh://…#subdirectory=boardex-app`
  form above, since pip clones the whole repo before building this subdirectory
  — the four resolve to local path requirements.
- **Without the siblings** they fall back to `==0.1.0` pins, for the day the
  four are published to an index.

Consequence, stated plainly: a wheel built from a checkout carries `file://`
requirements and **cannot be uploaded to PyPI as-is**. Publishing `boardex` to
PyPI requires publishing the four server packages there too (they version in
lockstep via `servers/VERSION`), after which the pinned fallback is exactly the
right metadata.

## Developing on it

```bash
pip install -e "servers/boardex-core[dev]" -e "servers/boardex-logic[dev]" \
            -e "servers/boardex-target[dev]" -e "servers/boardex-runner[dev,agent]"
npm run build -w apps/ui                    # VITE_RUNNER_URL="" for a same-origin bundle
BOARDEX_SKIP_UI_BUILD=1 pip install -e ./boardex-app
pytest boardex-app/tests
```

The build hook runs `npm run build -w apps/ui` for you unless
`BOARDEX_SKIP_UI_BUILD=1` is set, and copies `apps/ui/dist` plus the probe udev
rules into `boardex_app/_bundled/` (git-ignored, re-included in the wheel by
hatch's `artifacts`). The UI is built with `VITE_RUNNER_URL=""` so its runner
base is relative — that is what makes the single-origin serve work.
