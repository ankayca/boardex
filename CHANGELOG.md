# Changelog

All notable changes to Boardex are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While
Boardex is at 0.x, the wire contract between the runner and the dashboard is the thing
kept stable; anything else may move between releases.

## [0.1.0] — unreleased

The first release: the whole loop, end to end, on real hardware. Not yet published to
PyPI — install from git until it is.

### Added

- **The agent loop.** Describe a bring-up task in plain language and Boardex plans it,
  reads and edits the firmware, builds it, flashes the board, drives a logic analyzer,
  reads the capture back, and checks it against what the task said should happen. When a
  check fails it diagnoses the failure — ranked hypotheses with confidence and a proposed
  fix — and runs the fix as a new iteration in the same run.
- **Approval gates that actually block.** Nothing starts until you approve the plan, and
  the plan gate carries a bench-connection checklist you tick yourself, line by line,
  because Boardex cannot see your bench. Every action that touches hardware stops for a
  second approval regardless of what the profile says; rejecting ends the run cleanly
  with the tool provably never called, and stop is honored while a run is in flight.
- **Evidence-linked checks.** Every check records the artifact it came from — that link
  is enforced, not conventional. The evidence view gives you the protocol decode
  transaction by transaction, the logs per stream and per iteration, the code diff the
  agent wrote, and the raw captures, downloadable and openable in PulseView.
- **The validation report.** Outcome per requirement with deep links back into the
  evidence, exportable as Markdown to attach to a pull request. Run execution and
  validation coverage are reported as two separate numbers, because a run can fail with
  every check it managed to record passing — and no denominator is invented.
- **The dashboard.** A run workspace built around one question at a time: the step
  timeline on the left, the live build/flash/serial/agent logs in the middle, and a
  single rail on the right that holds whatever needs you right now. Plus a runs list,
  run history that reconstructs terminal runs entirely from replayed events, a command
  palette and keyboard-first navigation, and a settings screen.
- **Quick Start board profiles.** Point Boardex at a firmware folder and give the board a
  name; it validates the path, detects the build command, and compiles the rest of the
  profile from a scan of what is on the bench. The full profile editor is one click away
  and a Quick Start profile stays editable in it.
- **Provider credentials from the dashboard.** Paste a model provider key into Settings —
  no shell needed. The key is held in memory for the session and is write-only: no route
  serves it back, nothing touches disk, nothing is stored in the browser, and stopping the
  runner forgets it. Environment variables still work for booting pre-configured.
- **A demo that needs nothing.** `boardex up --demo` replays a recorded bring-up run in
  the browser with a short guided tour, touching no hardware, calling no model, and
  needing no API key — so it cannot half-fail on a machine that is missing something.
- **Recordings and replay.** Launch with `RECORD=<dir>` and the whole run is teed to
  `recorded_run.jsonl` plus an `artifacts/` folder: every event and every capture, in the
  same format the demo replays. A run someone else did can be handed to you intact, which
  is what makes a bug report reproducible.
- **One-command install.** `pipx install boardex`, then `boardex up` starts the runner
  with the dashboard embedded and served from the same origin. `boardex doctor` reports
  what the host is missing — compiler, sigrok, USB permissions, provider key — with a
  paste-ready fix resolved for the OS you are on, and never blocks anything.
- **The instrument layer.** Separate MCP servers for flashing and debugging targets
  (pyOCD: ST-Link, CMSIS-DAP) and for logic-analyzer capture and decode (sigrok:
  FX2-based analyzers, Kingst LA series). Adding a brand is a one-adapter job.
- **The wire contract.** A versioned event stream and command API between the runner and
  the dashboard, published as JSON Schema so both sides — and both languages — validate
  against the same definition rather than against each other.

[0.1.0]: https://github.com/ankayca/boardex/releases
