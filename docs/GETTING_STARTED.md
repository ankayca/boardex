# Getting Started with Boardex

Boardex plans a firmware bring-up, writes and builds the code, flashes the board, drives
a logic analyzer, reads the results back, and writes a report where every claim links to
the artifact that backs it. This page takes you from nothing installed to a real run.

You can go a long way before you need hardware — the demo needs none, and a build-only
run needs only a compiler.

## Install

### Prerequisites

- **Python 3.10 or newer.** `python3 --version` to check.
- **pipx**, and on Debian/Ubuntu it must come from apt:

  ```bash
  sudo apt install pipx && pipx ensurepath      # Debian / Ubuntu
  brew install pipx && pipx ensurepath          # macOS
  ```

  ```powershell
  py -m pip install --user pipx                 # Windows — Python 3.10+ from python.org
  py -m pipx ensurepath                         # then open a new terminal
  ```

  Use your package manager's pipx, not pip's. On Ubuntu 23.04+ and Debian 12+,
  `pip install --user pipx` stops with `error: externally-managed-environment` — the
  system Python refuses installs outside a virtualenv, and that refusal is the first
  thing a new machine hits. Windows is the exception: python.org's Python has no such
  refusal, so pip's pipx is the right form there. `pipx ensurepath` puts `~/.local/bin`
  on your `PATH`; open a new shell afterwards.

Nothing else is required to install Boardex or to run the demo. The tools for talking to
real hardware — an Arm compiler, `sigrok-cli`, USB permissions — come later, in
[Adding real hardware](#adding-real-hardware), and `boardex doctor` will tell you which
of them you are missing.

### From PyPI — the install to use

```bash
pipx install boardex
```

Nothing is compiled and no Node is needed: the published wheel carries the dashboard
already built, and the runner serves it from the same origin it serves the API on.

### From git — a branch or an unreleased fix, needs Node 20+

```bash
BOARDEX_LOCAL_SIBLINGS=1 pipx install \
  "git+ssh://git@github.com/ankayca/boardex.git#subdirectory=boardex-app"
```

Two things this form needs that the PyPI one does not:

- **Node 20+ and `npm` on your `PATH`.** pip clones the whole repository into a temp
  directory and builds the app there, and that build builds the dashboard too. Without
  Node the install stops and says so.
- **`BOARDEX_LOCAL_SIBLINGS=1`**, which points the four server dependencies at the clone
  pip already made rather than at their published releases — so what you install is the
  tree you pointed it at, end to end, and not your branch sitting on top of released
  servers.

Check it landed:

```bash
boardex --version
```

### From a checkout — for contributors

If you are going to change Boardex rather than use it, install the packages editable
instead. See **Working from a checkout** in the [README](../README.md#working-from-a-checkout).

## The 90-second demo

```bash
boardex up
```

That is the whole command. The dashboard opens on a first-run screen that offers **Watch
a demo run** beside starting a real one — click it, and Boardex replays a recorded
bring-up run in your browser with a short guided tour over the top. It touches no
hardware, calls no model, and needs no API key — the whole thing runs client-side, so it
cannot half-fail on a machine that is missing something.

There is also a shortcut that opens straight on the demo, skipping the click. This is the
form to use in a link you are sending someone:

```bash
boardex up --demo
```

It is the same launch pointed at the demo, with one difference behind it: it runs the
fake bench, so leaving the demo drops you into the live dashboard with something working
to click around in.

What the replay walks you through:

- **The plan gate.** Boardex proposes six plain-language steps with a risk level on each,
  and will not start until you approve.
- **The run.** Streaming build, flash and serial logs on one side; on the other, a single
  slot that shows what needs you right now — an approval card when the agent wants to
  flash, a diagnosis card when a check fails, the report link when it finishes.
- **The evidence.** A measurement fails, the agent proposes a cause and a fix, the fix
  runs, and the check flips to passing. Open any check and you get the protocol decode,
  the logs, and the code diff behind it.
- **The report.** A validation report with the outcome per requirement, exportable as
  Markdown.

Stop it with Ctrl-C.

## Your first real run, no hardware

The agent can do real work — read a firmware project, edit it, build it — with nothing
plugged in. That is the fastest way to see whether it behaves on *your* code.

### 1. Start Boardex

```bash
boardex up
```

It prints something like:

```
  Boardex 0.1.0 is up:  http://127.0.0.1:4380
    runner   real · bench agent · http://127.0.0.1:4380
    UI       embedded
    note     no provider key yet — set one at Settings → Model provider
             in the page above (or export a key before launch). The UI and
             the demo need none.
    Ctrl-C to stop.
```

Starting with no API key is fine, and that note is what you should see. If a browser
window does not appear — a headless box, an SSH session, some WSL setups — open the
printed URL yourself. Boardex says so rather than pretending it opened something.

### 2. Add a model provider key

Go to **Settings → Model provider** in the dashboard, paste your key, and Save. You do
not need a shell for this, and you should not use one: the runner holds the key in memory
for the session, write-only — no route serves a key back, nothing is written to disk, and
nothing is stored in the browser. Stop `boardex up` and it is gone.

You need an account with a model provider first. OpenRouter is the default (the key looks
like `sk-or-v1-…`); other providers work when the runner is configured for them, and the
dashboard shows a row per configured provider.

If you would rather boot pre-configured, exporting the provider's standard variable before
launch still works:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
boardex up
```

One trap worth naming: exporting the literal placeholder — `sk-or-v1-...`, dots and all —
exports a *string*, and the run then fails at 0:00 with no error in your terminal.
`echo ${OPENROUTER_API_KEY:0:12}` if you are unsure.

### 3. Point it at a firmware project

On the **New Run** screen, click **+ New board** and give Quick Start two things:

- **Repo path** — the path to a firmware folder *as the runner sees it*. It is a text
  field, not a file picker, because the runner may not be on the machine your browser is.
  Boardex checks the path when you leave the field and tells you what it found there:
  whether it is a buildable firmware folder, what build command it detected, or that the
  firmware looks like it is in a subfolder (with a button to accept that path).
- **Board name** — filled in from the folder name; edit it if you like.

Give the agent a **scratch copy of your firmware, not your working tree.** It edits real
files.

```bash
cp -r ~/firmware/my-project ~/firmware/agent-workspace
```

Everything else in the board profile — the build command, the MCU, the instrument ids —
is compiled for you when you create the run, from the bench scan and the path. The
**Advanced** link opens the full profile editor if you want to set them by hand, and a
Quick Start profile stays editable there afterwards.

### 4. Describe the task

Type what you want, in the same words you would use with a colleague. A good first task
is one that exercises the loop without needing a sensor on the bench:

> Change the console output format in the reference firmware to print `PRESSURE=<p>`
> alongside `TEMP`/`HUM`, and build it.

Then **Create Run Plan**.

### 5. Approve the plan

Boardex comes back with a plan: five to eight plain-language steps, each with a risk
level, a summary of the risky ones, and a **Confirm bench connections** checklist —
"Board powered", "Debug probe connected", "Serial cable connected", or whatever your
board profile says.

You tick each line yourself, and **Approve Plan** stays disabled until you have. That
gate is deliberate and it is not automated away: Boardex cannot see your bench. It does
not know whether the probe is on the right header, whether the board is powered, or
whether the sensor is on the bus it is about to drive — and the cost of guessing wrong is
a damaged board. Ticking a line is you attesting to a physical fact. Nothing pre-confirms
a line for you: not a validated repo path, not a healthy bench scan, not a default row.
For a build-only task there is nothing to plug in, so the checklist is a formality — but
it is the same gate that stands between the agent and your hardware later, and it behaves
identically either way.

### 6. Watch it work

The run workspace has three zones: the step timeline, the log pane, and a status rail on
the right.

- The **timeline** shows each step as it starts, succeeds, or fails.
- The **log pane** carries the agent's own reasoning plus the build, flash and serial
  streams as separate tabs. You can turn on per-line timestamps and search within a log.
- The **right rail** holds exactly one thing at a time, in the same place: what Boardex
  is currently doing, or an approval card when it wants to do something risky, or a
  diagnosis when a check fails, or the report link when it is done.

Any action that touches hardware — flashing, resetting — stops at an approval card
regardless of what the profile says. You can **Review Diff** before approving, and
rejecting ends the run cleanly with the tool provably never called.

If a check fails, the agent diagnoses it: ranked hypotheses with confidence, a proposed
fix, and its own approval gate. Approve, and the fix runs as a new iteration in the same
run, with a divider in the timeline so you can see what changed between attempts.

### 7. Read the evidence

Every check Boardex records links to the artifact it came from — that link is not
optional, it is enforced by the contract. Click a check and the evidence drawer opens:

- **Checks** — requirement, expected window, measured value, verdict, and the datasheet
  or schematic passage it was drawn from (following the citation scrolls to the exact
  heading in the source document).
- **Protocol decode** — the decoded bus transactions, address by address, with failed
  ones marked.
- **Logs** — per iteration, per stream.
- **Code diff** — what the agent changed.
- **Raw artifacts** — downloadable, including the sigrok capture, which opens in
  PulseView.

The **validation report** pulls it together: what the run was for, the board and firmware
context, the procedure, the outcome per requirement, and inline deep links back into the
evidence. **Copy Markdown** gives you something to attach to a PR.

Two numbers head the report, and they mean different things. *Run execution* is whether
the run finished. *Validation coverage* is how many of the checks it declared it actually
recorded. A run can fail — hit a turn budget, lose a probe — with every check it managed
to record passing. Boardex reports both rather than collapsing them, and it never invents
a denominator it was not given.

## Adding real hardware

### 1. Ask doctor what is missing

```bash
boardex doctor
```

It prints one line per check plus a paste-ready fix for anything that is not OK, resolved
for the OS you are on. It is advisory: it always exits 0, and nothing it reports blocks
`boardex up`. Only a real hardware run actually needs these.

| Check | Why it matters | The fix it prints |
|---|---|---|
| `python` | Everything. The floor is 3.10. | `install Python >= 3.10 (python.org/downloads, pyenv, or your package manager)` |
| `pyocd` | Flashing and debugging the target. Installed with Boardex; a warning here usually just means no probe is plugged in. | `pip install "boardex-target"    # pulls pyOCD` — or, if pyOCD is present and no probe enumerated, `connect a debug probe over USB (needed only to flash/debug)` |
| `sigrok-cli` | Logic-analyzer capture and protocol decode. | `sudo apt install sigrok-cli    # Kingst LA2016 needs a git-master build` (macOS: `brew install sigrok-cli`) |
| `arm-none-eabi-gcc` | Building the firmware under test. | `sudo apt install gcc-arm-none-eabi` (macOS: `brew install --cask gcc-arm-embedded`) |
| `usb-access` | Reaching the probe and the analyzer without root. On Linux this is udev rules; on Windows, a WinUSB driver binding. | see [udev, below](#2-usb-access-on-linux) |
| `provider-key` | Agent runs. The UI and the demo need none. | `boardex up`, then Settings → Model provider (no shell needed) — or `export OPENROUTER_API_KEY=...` before launch |
| `embedded-ui` | The dashboard itself. Bundled in the wheel; missing means a broken install. | `pip install --force-reinstall boardex` |
| `contract-schema` | The runner validates every event against these before emitting it, so without them it cannot run at all. | `pip install --force-reinstall boardex` |

The compiler matters in one non-obvious way: the agent builds in the environment
`boardex up` was launched from. If `which arm-none-eabi-gcc` resolves in your shell, it
resolves for the run.

### 2. USB access on Linux

Without a udev rule, your probe and analyzer are root-only and the run fails at flash
time. Doctor prints the exact command, with the rules file the install itself ships:

```bash
sudo cp ~/.local/share/pipx/venvs/boardex/lib/python3.*/site-packages/boardex_app/_bundled/udev/49-boardex-probes.rules \
  /etc/udev/rules.d/ && sudo udevadm control --reload && sudo udevadm trigger
```

Copy the path out of doctor's output rather than retyping this — it is resolved for your
install. Unplug and replug the device afterwards. Logic analyzers additionally want
libsigrok's own `60-libsigrok.rules`, which comes with a distro `sigrok-cli` package.

On macOS nothing is needed — pyOCD and libsigrok talk to libusb directly (`brew install
libusb` if enumeration fails). On Windows the probe needs a WinUSB-compatible driver bound
to its interface: the ST driver package for ST-Link, Zadig for CMSIS-DAP and sigrok
devices.

**Running Boardex inside WSL2** — the recommended way on Windows — adds one step before
any of this: WSL2 does not see Windows USB devices at all, so the probe or analyzer you
just plugged in simply does not exist on the Linux side. Attach it through
[usbipd-win](https://learn.microsoft.com/en-us/windows/wsl/connect-usb) — `usbipd list`
to find the device, `usbipd attach` to hand it to WSL; the procedure is in Microsoft's
docs. Once attached it enumerates as an ordinary Linux USB device, and the udev rules
above apply exactly as on a Linux box. For native-Windows driver binding, see the per-OS
notes in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md) and, for logic analyzers,
[`windows-sigrok-bringup.md`](windows-sigrok-bringup.md).

### 3. The board profile

Quick Start compiles a profile from your repo path and the bench scan. Once hardware is
involved you may want to open **Advanced** (or **Boards → Edit**) and fill in the parts a
scan cannot infer: the exact MCU target name, the build command if it is not the detected
one, and the instrument ids for the probe and analyzer you actually want used. **Validate
Profile** re-checks the profile against what is on the bench and tells you which
instruments it found.

The **connection checklist** is worth editing properly. Quick Start seeds it with three
generic preconditions, and the panel says as much so nobody mistakes a default for a
checked fact about their board. Replacing them with the real wiring for *your* bench —
which pin to which pin, which pull-ups, which rail — is what makes the plan gate useful
rather than ceremonial. Boardex does not draw wiring diagrams; this list is the wiring
contract, and you author it once per board.

### 4. Going further

Instrument support, per-OS caveats, and what is Tier 1 versus best-effort:
[`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md). Kingst logic analyzers need a one-time
bring-up (a recent libsigrok build plus user-extracted firmware) before sigrok will see
them: [`kingst-la-bringup.md`](kingst-la-bringup.md). For flashing specifics — target
names, recovering a wedged board — see
[`servers/boardex-target/README.md`](../servers/boardex-target/README.md).

## Troubleshooting

| What you see | What it is | What to do |
|---|---|---|
| `boardex: port 4380 is in use — is another boardex/runner already running?` | Something already holds the port, usually an earlier `boardex up` that did not exit. | Stop it, or `boardex up --port 4381`. Boardex checks the port *before* starting anything, so nothing half-started. |
| The browser never opened. | Common on WSL, over SSH, and on headless boxes. Not a failure. | Open the URL from the banner yourself. `boardex up --no-open` skips the attempt entirely. |
| Run FAILED at 0:00, stuck on "waiting for the plan". | Almost always the API key: missing, a pasted placeholder, or rejected by the provider. The first model call died. | Settings → Model provider. The provider's actual error message is in the run's **Agent** log in the dashboard, not in your terminal. |
| Run FAILED at 0:00 and the key is definitely good. | The repo path does not exist on the machine running the runner. | Check the path in the board profile. It is read on the *runner's* filesystem. |
| The sidebar pill says **mock**, not **real**. | The dashboard is talking to a mock runner instead of yours. Under `boardex up` the runner serves the dashboard itself, so this means the Runner URL was pointed elsewhere. | Settings → Runner URL → **Test connection**, which verifies before you commit to it. |
| Amber "not found on the bench" on a profile or plan. | An instrument named in the profile did not turn up in the scan. | Advisory, never blocking. Plug it in, or run anyway and let the run fail honestly at the step that needs it. |
| The build step fails and the agent diagnoses a missing compiler. | `arm-none-eabi-gcc` is not on the `PATH` of the shell that launched `boardex up`. | Launch from a shell where `which arm-none-eabi-gcc` resolves. |
| Settings → Model provider refuses to save from another machine. | Deliberate. The credential routes require a loopback host, as a defense against DNS rebinding. | Set the key from the machine running the runner. With `--host 0.0.0.0`, a remote browser can use everything else. |
| An empty recording after using `RECORD=`. | Either two runners were listening and the browser drove the wrong one, or the runner was killed rather than stopped. | One listener on the port, and Ctrl-C after the run reaches a terminal state — the recording flushes on shutdown. |

## What's next

**Keep a run.** Launch with `RECORD=<dir>` and Boardex tees the whole run to
`<dir>/recorded_run.jsonl` plus an `artifacts/` folder:

```bash
RECORD=$PWD/records/my-run boardex up
```

That folder is the complete run — every event, every capture — in the same format the
demo replays. It is what to attach to a bug report, and it means a run someone else did
can be handed to you intact.

**Tell us what confused you.** This is early software with very few users, and the most
useful thing you can send is not "it broke" but *where you stopped being sure what was
happening* — a command that did not do what its name suggested, a screen you could not
tell was waiting for you, a message you had to reread. Open an issue with your
`boardex doctor` output and, if a run was involved, its recording.
