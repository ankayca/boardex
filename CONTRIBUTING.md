# Contributing to Boardex

Thanks for looking. Boardex is early software with few users, so the most valuable
contributions right now are the unglamorous ones: a reproduction, a failing test, a
message that made no sense to you.

## The one thing to understand first

Boardex is two halves that never talk to each other directly. The **runner** does the
physical work — plans a run, edits and builds firmware, flashes the board, drives the
logic analyzer, collects artifacts. The **dashboard** shows it and holds the approval
gates. Between them sits a **wire contract**: a versioned event stream plus a small HTTP
command API, living in `packages/contract` as schemas that both sides validate against.

That contract is the single source of truth. Neither half is allowed to be the
authority on what the other sees. In practice this means the two halves are developed
independently — the dashboard against a mock runner that replays a recorded run, the
runner against the contract's emitted JSON Schema — and they meet only at the wire. If a
change requires the two sides to agree on something new, **the contract changes first**,
then the mock, then both halves.

## Ground rules

- **Everything lands via pull request.** No direct pushes to `main`. CI has to be green,
  and a human does the merge.
- **Contract changes get the most scrutiny.** `packages/contract` is additive-only: new
  event types and new optional fields are fine; renaming, removing, or quietly
  repurposing an existing one is not. Recorded runs from older versions have to keep
  replaying, and a dashboard that is one version behind has to keep working. Expect a
  contract PR to take longer than a feature PR. That is the trade we chose.
- **Server-side changes get an owner review.** Anything under `servers/` is reviewed by
  the maintainer who owns that layer — see
  [`servers/CONTRIBUTING.md`](servers/CONTRIBUTING.md) for its layout and conventions.
- **One idea per PR.** A drive-by refactor bundled with a fix costs the reviewer the
  ability to judge either.

## Setting up

The [README](README.md) has the from-a-checkout install: the Python packages editable,
`npm install` for the JavaScript side, then the CLI against the tree you just built.

Two commands are the local gate, and they are what CI runs:

```bash
npm run verify        # typecheck + lint + test across the JavaScript workspaces

pytest servers/boardex-core/tests servers/boardex-target/tests \
       servers/boardex-logic/tests servers/boardex-runner/tests
pytest boardex-app/tests            # if you touched the CLI or packaging
```

Run both before you open the PR. CI adds a browser smoke test and a matrix across
Python 3.10/3.12/3.13 on Linux, macOS and Windows, so a change that only works on your
machine will be found — just later, and by a robot instead of by you.

**Every test suite is hardware-free by design.** Nothing in the automated tests needs a
board, a probe, or an analyzer plugged in, and it must stay that way: adapters are tested
against fakes, and the wire behavior is tested against recordings. You can develop and
verify essentially all of Boardex with an empty bench.

## What good looks like here

**Write tests that can fail.** When you add a test, break the code it covers — flip the
comparison, return the wrong value, delete the guard — and watch the test go red. Then
put the code back. It takes thirty seconds and it is the only way to know your test
asserts behavior rather than merely executing lines. A test that cannot fail is worse
than no test: it costs the same to run and it actively lies to the next person about
what is covered. In review, "does this test have a mutation that kills it?" is a fair
question to be asked, and an untested-but-correct change is usually sent back.

**Fail honestly instead of falling back silently.** If a device is missing, a key is
absent, or a path does not exist, say so at the point it happens and stop. Do not
substitute a default, retry into a different code path, or degrade into something that
looks like success. A run that fails loudly at second zero costs a user a minute; a run
that silently used a stand-in costs them an afternoon and their trust in every number
Boardex has ever shown them.

**Never invent data on a user-facing surface.** Every measurement shown has to trace to
the artifact that produced it, every check links to its evidence, and a count is never
displayed against a denominator nobody supplied. If a value is unknown, the honest render
is that it is unknown. This is the rule with the least tolerance for exceptions in the
whole project — placeholder numbers that look plausible are the single fastest way to
make a tool like this worthless.

## Where decisions live

[`docs/decisions.md`](docs/decisions.md) is an append-only log: one dated line per
significant choice, including the ones we later regretted. If your change involves a
real decision — a trade-off, a rejected alternative, a deliberate limitation — add the
line in the same PR. Nobody needs to read a rationale for a typo fix; everybody needs to
read one before re-litigating a choice made six months ago.

Entries are never edited away. If a decision is reversed, the reversal is a new line.

## Adding support for your hardware

Adding a probe, an analyzer, or another instrument brand is deliberately a one-adapter
job: implement the interface for that instrument class, register it, and the rest of
the stack — tools, runner, dashboard — picks it up without changing. See the
"How to add a new backend" section of [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for
the walkthrough, and [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md) for what is
already supported and at what tier.

If you get an adapter working for hardware we do not own, we would very much like the
PR — including the notes about what was weird on that device.

## Reporting a vulnerability

Not through an issue. See [`SECURITY.md`](SECURITY.md).
